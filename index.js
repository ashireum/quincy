const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const pdfParse = require('pdf-parse');
const axios = require('axios');
const http = require('http');

// Dummy web server to keep Render's port checker happy
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
let dynamicQuiz = [];

client.once('ready', () => {
    console.log(`🤖 Quiz Bot is online as ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const attachment = message.attachments.first();
    if (!attachment || !attachment.name.endsWith('.pdf')) return;

    try {
        const loadingMessage = await message.reply("⏳ Reading your PDF and extracting multiple choice questions... Please wait!");

        const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        const data = await pdfParse(buffer);
        
        dynamicQuiz = parseQuestions(data.text);

        if (dynamicQuiz.length === 0) {
            await loadingMessage.edit("❌ I couldn't extract any questions. Make sure the PDF format has clear 'A, B, C, D' options.");
            return;
        }

        const startEmbed = new EmbedBuilder()
            .setTitle("📚 Quiz Ready!")
            .setDescription(`Successfully extracted **${dynamicQuiz.length}** multiple choice questions from your file.\n\nClick the button below to start your review session!`)
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
        message.reply("❌ An error occurred while parsing the PDF file.");
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    // Instantly bypass Discord's 3-second limit by sending an immediate ACK signal
    try {
        await interaction.deferReply({ ephemeral: true });
        // Delete the ephemeral acknowledgment right away so it doesn't clutter the UI
        await interaction.deleteReply();
    } catch (err) {
        // Safe catch if Discord handles the acknowledgment smoothly
    }

    const channel = interaction.channel;

    // 1. START QUIZ
    if (interaction.customId === 'dyn_start_quiz') {
        if (dynamicQuiz.length === 0) return;

        const firstItem = dynamicQuiz[0];
        const questionEmbed = new EmbedBuilder()
            .setTitle(`📝 Question 1`)
            .setDescription(`**${firstItem.question}**\n\n🅰️ ${firstItem.options.A}\n🅱️ ${firstItem.options.B}\n🆃 ${firstItem.options.C}\n🅳 ${firstItem.options.D}`)
            .setColor(0x3498db)
            .setFooter({ text: `Score: 0/${dynamicQuiz.length}` });

        const btnRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dyn_answer_0_0_A`).setLabel('A').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`dyn_answer_0_0_B`).setLabel('B').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`dyn_answer_0_0_C`).setLabel('C').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`dyn_answer_0_0_D`).setLabel('D').setStyle(ButtonStyle.Secondary)
        );

        // Send a fresh new message in the chat channel to completely bypass old message locks
        await channel.send({ embeds: [questionEmbed], components: [btnRow] });

    // 2. EVALUATE CHOSEN ANSWER
    } else if (interaction.customId.startsWith('dyn_answer_')) {
        const [, indexStr, scoreStr, chosen] = interaction.customId.split('_');
        const idx = parseInt(indexStr);
        let currentScore = parseInt(scoreStr);
        const currentItem = dynamicQuiz[idx];

        const isCorrect = chosen === currentItem.correct;
        if (isCorrect) currentScore++;

        let breakdown = "";
        for (const [key, val] of Object.entries(currentItem.options)) {
            if (key === currentItem.correct) breakdown += `🟢 **${val} (Correct Answer)**\n`;
            else if (key === chosen) breakdown += `🔴 **${val} (Your Pick)**\n`;
            else breakdown += `⚪ ${val}\n`;
        }

        const evaluationEmbed = new EmbedBuilder()
            .setTitle(`Question ${idx + 1} Feedback`)
            .setDescription(`**Result:** ${isCorrect ? '✨ Correct!' : '❌ Incorrect'}\n\n${breakdown}\n**💡 Rationale/Notes:**\n${currentItem.rationale}`)
            .setColor(isCorrect ? 0x2ecc71 : 0xe74c3c)
            .setFooter({ text: `Progress: ${currentScore}/${idx + 1}` });

        const navigationRow = new ActionRowBuilder();
        if (idx + 1 < dynamicQuiz.length) {
            navigationRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`dyn_next_${idx + 1}_${currentScore}`)
                    .setLabel('Next Question ➡️')
                    .setStyle(ButtonStyle.Primary)
            );
        } else {
            evaluationEmbed.addFields({ name: '🏁 Finish!', value: `Final Score: ${currentScore}/${dynamicQuiz.length}` });
        }

        await channel.send({ embeds: [evaluationEmbed], components: navigationRow.components.length ? [navigationRow] : [] });

    // 3. NEXT QUESTION GENERATION
    } else if (interaction.customId.startsWith('dyn_next_')) {
        const [, nextIndexStr, nextScoreStr] = interaction.customId.split('_');
        const index = parseInt(nextIndexStr);
        const score = parseInt(nextScoreStr);
        const activeItem = dynamicQuiz[index];
        
        const questionEmbed = new EmbedBuilder()
            .setTitle(`📝 Question ${index + 1}`)
            .setDescription(`**${activeItem.question}**\n\n🅰️ ${activeItem.options.A}\n🅱️ ${activeItem.options.B}\n🆃 ${activeItem.options.C}\n🅳 ${activeItem.options.D}`)
            .setColor(0x3498db)
            .setFooter({ text: `Score: ${score}/${dynamicQuiz.length}` });

        const btnRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dyn_answer_${index}_${score}_A`).setLabel('A').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`dyn_answer_${index}_${score}_B`).setLabel('B').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`dyn_answer_${index}_${score}_C`).setLabel('C').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`dyn_answer_${index}_${score}_D`).setLabel('D').setStyle(ButtonStyle.Secondary)
        );

        await channel.send({ embeds: [questionEmbed], components: [btnRow] });
    }
});

function parseQuestions(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const questions = [];
    let currentQuestion = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

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

        if (/^[A-D\u1F1E6-\u1F1E9][\.\)]/i.test(line)) {
            const letter = line[0].toUpperCase();
            currentQuestion.options[letter] = line.replace(/^[A-D][\.\)]\s*/i, '');
            continue;
        }

        if (line.toLowerCase().includes('answer:') || line.toLowerCase().includes('correct answer:')) {
            const match = line.match(/(?:answer:\s*([A-D]))/i);
            if (match) currentQuestion.correct = match[1].toUpperCase();
            continue;
        }

        if (line.toLowerCase().startsWith('rationale:') || line.toLowerCase().startsWith('explanation:')) {
            currentQuestion.rationale = line.replace(/^(?:rationale|explanation):\s*/i, '');
            continue;
        }

        if (currentQuestion && Object.keys(currentQuestion.options).length === 0) {
            currentQuestion.question += " " + line;
        }
    }

    if (currentQuestion && currentQuestion.question && currentQuestion.options.A) {
        questions.push(currentQuestion);
    }

    return questions;
}

client.login(TOKEN);
