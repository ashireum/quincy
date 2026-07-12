const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const pdfParse = require('pdf-parse');
const axios = require('axios');
const http = require('http');

// Dummy web server to satisfy Render's port check
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Quiz engine active!\n');
});
server.listen(process.env.PORT || 3000, () => {
    console.log(`🌐 Web listener online`);
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const TOKEN = process.env.DISCORD_TOKEN;

// Global memory map locked to text channel IDs
const globalStorage = new Map();

client.once('ready', () => {
    console.log(`🤖 Quiz Bot is online as ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const attachment = message.attachments.first();
    if (!attachment) return;
    
    const isPDF = attachment.name.endsWith('.pdf');
    const isTXT = attachment.name.endsWith('.txt');
    if (!isPDF && !isTXT) return;

    try {
        const loadingMessage = await message.reply(`⏳ Reading your ${isPDF ? 'PDF' : 'Text'} file and extracting questions... Please wait!`);

        const response = await axios.get(attachment.url, { responseType: isPDF ? 'arraybuffer' : 'text' });
        let extractedText = "";

        if (isPDF) {
            const buffer = Buffer.from(response.data);
            const data = await pdfParse(buffer);
            extractedText = data.text;
        } else {
            extractedText = response.data;
        }
        
        const questions = parseQuestions(extractedText);

        if (questions.length === 0) {
            await loadingMessage.edit("❌ I couldn't extract any questions. Make sure the format matches: \n`ANSWER: “D”. text` right below option D.");
            return;
        }

        globalStorage.set(message.channel.id, questions);

        const startEmbed = new EmbedBuilder()
            .setTitle("📚 Quiz Ready!")
            .setDescription(`Successfully extracted **${questions.length}** multiple choice questions from your file.\n\nClick the button below to start your review session!`)
            .setColor(0x2ecc71);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('dyn_start_quiz')
                .setLabel('🎯 Start Quiz')
                .setStyle(ButtonStyle.Success)
        );

        await loadingMessage.edit({ content: '', embeds: [startEmbed], components: [row] });

    } catch (error) {
        console.error(error);
        message.reply("❌ An error occurred while parsing the file.");
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    try {
        await interaction.deferUpdate();
    } catch (err) {
        console.error("Defer update failed:", err);
        return; 
    }

    const channel = interaction.channel;
    let questions = globalStorage.get(channel.id);

    // AUTO-RESTORE MEMORY BACKUP PLAN
    if (!questions || questions.length === 0) {
        try {
            const messages = await channel.messages.fetch({ limit: 15 });
            const targetMessage = messages.find(m => {
                const att = m.attachments.first();
                return att && (att.name.endsWith('.pdf') || att.name.endsWith('.txt'));
            });
            
            if (targetMessage) {
                const attachment = targetMessage.attachments.first();
                const isPDF = attachment.name.endsWith('.pdf');
                const response = await axios.get(attachment.url, { responseType: isPDF ? 'arraybuffer' : 'text' });
                let extractedText = "";
                
                if (isPDF) {
                    const buffer = Buffer.from(response.data);
                    const data = await pdfParse(buffer);
                    extractedText = data.text;
                } else {
                    extractedText = response.data;
                }
                questions = parseQuestions(extractedText);
                globalStorage.set(channel.id, questions);
            }
        } catch (e) {
            console.error("Auto-restore tracking failed:", e);
        }
    }

    if (!questions || questions.length === 0) {
        return channel.send("⚠️ **Session Error:** Please upload your file fresh to sync the question tracking!");
    }

    // 1. START THE QUIZ PANEL
    if (interaction.customId === 'dyn_start_quiz') {
        const firstItem = questions[0];
        const questionEmbed = new EmbedBuilder()
            .setTitle(`📝 Question 1`)
            .setDescription(`**${firstItem.question}**\n\n**A.** ${firstItem.options.A}\n**B.** ${firstItem.options.B}\n**C.** ${firstItem.options.C}\n**D.** ${firstItem.options.D}`)
            .setColor(0x3498db)
            .setFooter({ text: `Total Items: ${questions.length}` });

        const btnRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dyn_answer_0_0_A`).setLabel('A').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`dyn_answer_0_0_B`).setLabel('B').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`dyn_answer_0_0_C`).setLabel('C').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`dyn_answer_0_0_D`).setLabel('D').setStyle(ButtonStyle.Secondary)
        );

        await interaction.message.edit({ embeds: [questionEmbed], components: [btnRow] });

    // 2. CHECK MULTIPLE CHOICE ANSWER TAPS
    } else if (interaction.customId.startsWith('dyn_answer_')) {
        const [, indexStr, scoreStr, chosen] = interaction.customId.split('_');
        const idx = parseInt(indexStr);
        let currentScore = parseInt(scoreStr);
        const currentItem = questions[idx];

        if (!currentItem) return;

        const isCorrect = chosen === currentItem.correct;
        if (isCorrect) currentScore++;

        let breakdown = "";
        for (const [key, val] of Object.entries(currentItem.options)) {
            if (key === currentItem.correct) breakdown += `✅ **${key}. ${val} (Correct Answer)**\n`;
            else if (key === chosen) breakdown += `❌ **${key}. ${val} (Your Pick)**\n`;
            else breakdown += `🔹 ${key}. ${val}\n`;
        }

        const evaluationEmbed = new EmbedBuilder()
            .setTitle(`Question ${idx + 1} Feedback`)
            .setDescription(`**Result:** ${isCorrect ? '✨ Correct!' : '⚠️ Incorrect'}\n\n${breakdown}\n**💡 Rationale/Notes:**\n${currentItem.rationale}`)
            .setColor(isCorrect ? 0x2ecc71 : 0xe74c3c)
            .setFooter({ text: `Progress: ${currentScore}/${idx + 1}` });

        const navigationRow = new ActionRowBuilder();
        if (idx + 1 < questions.length) {
            navigationRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`dyn_next_${idx + 1}_${currentScore}`)
                    .setLabel('Next Question ➡️')
                    .setStyle(ButtonStyle.Primary)
            );
        } else {
            evaluationEmbed.addFields({ name: '🏁 Finish!', value: `Final Score: ${currentScore}/${questions.length}` });
        }

        await interaction.message.edit({ embeds: [evaluationEmbed], components: navigationRow.components.length ? [navigationRow] : [] });

    // 3. GENERATE NEXT CARD PROMPT
    } else if (interaction.customId.startsWith('dyn_next_')) {
        const [, nextIndexStr, nextScoreStr] = interaction.customId.split('_');
        const index = parseInt(nextIndexStr);
        const score = parseInt(nextScoreStr);
        const activeItem = questions[index];
        
        if (!activeItem) return;

        const questionEmbed = new EmbedBuilder()
            .setTitle(`📝 Question ${index + 1}`)
            .setDescription(`**${activeItem.question}**\n\n**A.** ${activeItem.options.A}\n**B.** ${activeItem.options.B}\n**C.** ${activeItem.options.C}\n**D.** ${activeItem.options.D}`)
            .setColor(0x3498db)
            .setFooter({ text: `Score: ${score}/${questions.length}` });

        const btnRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dyn_answer_${index}_${score}_A`).setLabel('A').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`dyn_answer_${index}_${score}_B`).setLabel('B').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`dyn_answer_${index}_${score}_C`).setLabel('C').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`dyn_answer_${index}_${score}_D`).setLabel('D').setStyle(ButtonStyle.Secondary)
        );

        await interaction.message.edit({ embeds: [questionEmbed], components: [btnRow] });
    }
});

function parseQuestions(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const questions = [];
    let currentQuestion = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Detects Question Line (e.g., "1. Question text")
        if (/^\d+[\.\)]/.test(line)) {
            if (currentQuestion && currentQuestion.question && currentQuestion.options.A) {
                questions.push(currentQuestion);
            }
            currentQuestion = {
                question: line.replace(/^\d+[\.\)]\s*/, ''),
                options: {},
                correct: 'A', 
                rationale: 'No specific study note provided in document.'
            };
            continue;
        }

        if (!currentQuestion) continue;

        // Detects Option Lines (A, B, C, D)
        if (/^[A-D][\.\)]/i.test(line)) {
            const letter = line[0].toUpperCase();
            currentQuestion.options[letter] = line.replace(/^[A-D][\.\)]\s*/i, '');
            continue;
        }

        // Matches: ANSWER: “D”. 8-16 months OR ANSWER: "D". text
        if (line.toUpperCase().startsWith('ANSWER:')) {
            const letterMatch = line.match(/ANSWER:\s*[\u201C\u201D"']([A-D])[\u201C\u201D"']/i);
            if (letterMatch) {
                currentQuestion.correct = letterMatch[1].toUpperCase();
            }
            continue;
        }

        // Extract Rationale notes if any exist
        if (line.toLowerCase().startsWith('rationale:') || line.toLowerCase().startsWith('explanation:')) {
            currentQuestion.rationale = line.replace(/^(?:rationale|explanation):\s*/i, '');
            continue;
        }

        // Catch multi-line questions
        if (currentQuestion && Object.keys(currentQuestion.options).length
