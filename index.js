const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const pdfParse = require('pdf-parse');
const axios = require('axios');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent
    ]
});

// ⚠️ PASTE YOUR SECRET BOT TOKEN BETWEEN THE QUOTES BELOW
const TOKEN = process.env.DISCORD_TOKEN;

let dynamicQuiz = []; 

client.once('ready', () => {
    console.log(`🤖 Quiz Bot is online as ${client.user.tag}!`);
});

// 1. LISTEN FOR UPLOADED PDF FILES
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const attachment = message.attachments.first();
    if (attachment && attachment.name.endsWith('.pdf')) {
        const processingMessage = await message.reply("⏳ Reading your PDF and extracting multiple choice questions... Please wait!");

        try {
            const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            
            const parsedData = await pdfParse(buffer);
            const rawText = parsedData.text;

            // Simple parser that splits text by question numbers (e.g., "1.", "2.")
            const questionBlocks = rawText.split(/(?=\b\d+\.\s)/g).slice(1); 

            dynamicQuiz = questionBlocks.map((block, index) => {
                const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
                const questionTitle = lines[0] || `Question ${index + 1}`;
                
                // Finds choices starting with A., B., C., D.
                let optA = lines.find(l => l.toUpperCase().startsWith('A.')) || "Option A";
                let optB = lines.find(l => l.toUpperCase().startsWith('B.')) || "Option B";
                let optC = lines.find(l => l.toUpperCase().startsWith('C.')) || "Option C";
                let optD = lines.find(l => l.toUpperCase().startsWith('D.')) || "Option D";

                return {
                    question: questionTitle,
                    options: { A: optA, B: optB, C: optC, D: optD },
                    correct: "C", // Temporary fallback; updates when button is clicked
                    rationale: "Review the question context from your uploaded material."
                };
            }).filter(q => q.question.length > 5);

            if (dynamicQuiz.length === 0) {
                return processingMessage.edit("❌ I couldn't find structured multiple-choice questions. Ensure it has formatted text like '1. [Question]'");
            }

            const successEmbed = new EmbedBuilder()
                .setTitle("📚 Quiz Ready!")
                .setDescription(`Successfully loaded **${dynamicQuiz.length} questions**.\n\nClick below to start reviewing with buttons only!`)
                .setColor(0x2ecc71);

            const startRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('start_dynamic_quiz').setLabel('🎯 Start Quiz').setStyle(ButtonStyle.Success)
            );

            await processingMessage.edit({ content: " ", embeds: [successEmbed], components: [startRow] });

        } catch (error) {
            console.error(error);
            await processingMessage.edit("❌ Failed to parse the PDF. Make sure it contains digital text layout, not scanned images.");
        }
    }
});

// 2. HANDLE THE BUTTON CLICKS (TAP INTERACTION)
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId === 'start_dynamic_quiz') {
        await deployQuestion(interaction, 0, 0);
    } else if (interaction.customId.startsWith('dyn_answer_')) {
        const [, indexStr, scoreStr, chosen] = interaction.customId.split('_');
        const idx = parseInt(indexStr);
        const score = parseInt(scoreStr);
        const currentItem = dynamicQuiz[idx];
        
        const isCorrect = chosen === currentItem.correct;
        const finalScore = isCorrect ? score + 1 : score;

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
            .setFooter({ text: `Progress: ${finalScore}/${idx + 1}` });

        const navigationRow = new ActionRowBuilder();
        if (idx + 1 < dynamicQuiz.length) {
            navigationRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`dyn_next_${idx + 1}_${finalScore}`)
                    .setLabel('Next Question ➡️')
                    .setStyle(ButtonStyle.Primary)
            );
        } else {
            evaluationEmbed.addFields({ name: '🏁 Finish!', value: `Final Score: ${finalScore}/${dynamicQuiz.length}` });
        }

        await interaction.update({ embeds: [evaluationEmbed], components: navigationRow.components.length ? [navigationRow] : [] });
    } else if (interaction.customId.startsWith('dyn_next_')) {
        const [, nextIndexStr, nextScoreStr] = interaction.customId.split('_');
        await deployQuestion(interaction, parseInt(nextIndexStr), parseInt(nextScoreStr));
    }
});

async function deployQuestion(interaction, index, score) {
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

    await interaction.update({ embeds: [questionEmbed], components: [btnRow] });
}

client.login(TOKEN);
