const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, ApplicationCommandOptionType } = require('discord.js');
const pdfParse = require('pdf-parse');
const axios = require('axios');
const http = require('http');

const SHUFFLE_QUESTIONS = false;
const SHUFFLE_CHOICES = false;

// Dummy web server for hosting checks
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Quiz engine active!\n');
});
server.listen(process.env.PORT || 3000, () => {
    console.log(`🌐 Web listener online`);
});

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const TOKEN = process.env.DISCORD_TOKEN;

// Keyed by interaction ID or user ID to avoid channel collisions
const globalStorage = new Map();

// --- PRE-COMPILED PARSER REGEXES ---
const QUESTION_START_REGEX = /^(?:(?:Question|Q|No\.)\s*)?(\d+)(?:[\.\)]|(?:\s+))?/i;
const ISOLATED_YEAR_REGEX = /^(19|20)\d{2}$/;
const OPTION_START_REGEX = /^([A-D])\s*[\.\):\-\u2013\u2014]/i;
const ANSWER_KEY_REGEX = /^(?:CORRECT\s+)?ANSWER\s*[:\-\s=]+\s*[\u201C\u201D"']?([A-D])[\u201C\u201D"']?(?:\.|\b)/i;
const RATIONALE_START_REGEX = /^(?:Rationale|Explanation)\s*:\s*/i;
const ARTIFACT_REGEX = /^(?:page\s*\d+|\d+\s*\/\s*\d+|copyright|ncm\s*\d+)/i;

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function parseQuestions(text) {
    if (!text || typeof text !== 'string') return [];
    const lines = text.split('\n').map(line => line.trim());
    const questions = [];
    let currentQuestion = null;
    let parsingStage = 'none';

    for (let line of lines) {
        if (!line || ARTIFACT_REGEX.test(line)) continue;

        const qMatch = line.match(QUESTION_START_REGEX);
        if (qMatch && !ISOLATED_YEAR_REGEX.test(line)) {
            if (currentQuestion && currentQuestion.question && Object.keys(currentQuestion.options).length >= 2) {
                questions.push(currentQuestion);
            }
            currentQuestion = {
                question: line.replace(QUESTION_START_REGEX, '').trim(),
                options: {},
                correct: 'A',
                rationale: '',
                originalOrder: ['A', 'B', 'C', 'D']
            };
            parsingStage = 'question';
            continue;
        }

        if (!currentQuestion) continue;

        const oMatch = line.match(OPTION_START_REGEX);
        if (oMatch) {
            const letter = oMatch[1].toUpperCase();
            currentQuestion.options[letter] = line.replace(OPTION_START_REGEX, '').trim();
            parsingStage = 'options';
            continue;
        }

        const aMatch = line.match(ANSWER_KEY_REGEX);
        if (aMatch) {
            currentQuestion.correct = aMatch[1].toUpperCase();
            parsingStage = 'rationale';
            continue;
        }

        if (RATIONALE_START_REGEX.test(line)) {
            currentQuestion.rationale = line.replace(RATIONALE_START_REGEX, '').trim();
            parsingStage = 'rationale';
            continue;
        }

        if (parsingStage === 'question') {
            currentQuestion.question += ' ' + line;
        } else if (parsingStage === 'options') {
            const existingLetters = Object.keys(currentQuestion.options);
            if (existingLetters.length > 0) {
                const lastLetter = existingLetters[existingLetters.length - 1];
                currentQuestion.options[lastLetter] += ' ' + line;
            }
        } else if (parsingStage === 'rationale') {
            currentQuestion.rationale += (currentQuestion.rationale ? '\n' : '') + line;
        }
    }

    if (currentQuestion && currentQuestion.question && Object.keys(currentQuestion.options).length >= 2) {
        questions.push(currentQuestion);
    }

    return questions.map(q => {
        q.question = q.question.replace(/\s+/g, ' ').trim();
        q.rationale = q.rationale.trim() || 'No specific study note provided.';
        let displayChoices = Object.keys(q.options).sort();
        if (SHUFFLE_CHOICES) {
            const correctText = q.options[q.correct];
            displayChoices = shuffleArray([...displayChoices]);
            const newOptions = {};
            displayChoices.forEach((letter, index) => {
                const targetKey = String.fromCharCode(65 + index);
                newOptions[targetKey] = q.options[letter];
                if (q.options[letter] === correctText) q.correct = targetKey;
            });
            q.options = newOptions;
            displayChoices = Object.keys(newOptions).sort();
        }
        q.originalOrder = displayChoices;
        return q;
    });
}

function buildQuizEmbed(item, index, total, score, answeredCount, chosen = null) {
    const embed = new EmbedBuilder().setColor(0x3498db);
    const regionalIndicators = { A: '🇦', B: '🇧', C: '🇨', D: '🇩' };

    if (!chosen) {
        embed.setTitle(`📝 Question ${index + 1} of ${total}`)
            .setDescription(`**${item.question}**`)
            .setFooter({ text: `Question ${index + 1}/${total} • Current Score: ${score}/${answeredCount}` });

        item.originalOrder.forEach(letter => {
            if (item.options[letter]) {
                embed.addFields({ name: `${regionalIndicators[letter]} Option ${letter}`, value: item.options[letter], inline: false });
            }
        });
    } else {
        const isCorrect = chosen === item.correct;
        embed.setColor(isCorrect ? 0x2ecc71 : 0xe74c3c)
            .setTitle(`Question ${index + 1} Feedback`)
            .setDescription(`**Your Verdict:** ${isCorrect ? '✨ Correct!' : '⚠️ Incorrect'}\n\n**Question:**\n${item.question}`)
            .setFooter({ text: `Progress: ${index + 1} of ${total} • Score: ${score} Correct` });

        item.originalOrder.forEach(letter => {
            let label = `${regionalIndicators[letter]} Option ${letter}`;
            if (letter === item.correct) label += ' ✅ (Correct)';
            else if (letter === chosen) label += ' ❌ (Your Pick)';
            if (item.options[letter]) {
                embed.addFields({ name: label, value: item.options[letter], inline: false });
            }
        });
        embed.addFields({ name: '💡 Rationale & Clinical Notes', value: item.rationale, inline: false });
    }
    return embed;
}

// --- AUTOMATIC COMMAND REGISTRATION ON BOOT ---
client.once('ready', async () => {
    console.log(`🤖 Quiz Bot is online as ${client.user.tag}!`);

    const commands = [
        {
            name: 'quiz',
            description: 'Upload a PDF or TXT reviewer to start an interactive private quiz deck.',
            options: [
                {
                    name: 'reviewer',
                    description: 'Select your study file (.pdf or .txt format only)',
                    type: ApplicationCommandOptionType.Attachment,
                    required: true
                }
            ]
        }
    ];

    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        console.log('⏳ Synchronizing global slash application commands...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Global application slash commands registered successfully.');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
});

// --- INTERACTION HANDLING HUB ---
client.on('interactionCreate', async (interaction) => {
    // A. HANDLE SLASH COMMAND EXECUTION
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'quiz') {
            const attachment = interaction.options.getAttachment('reviewer');
            if (!attachment) return interaction.reply({ content: "❌ Missing file attachment parameters.", ephemeral: true });

            const isPDF = attachment.name.endsWith('.pdf');
            const isTXT = attachment.name.endsWith('.txt');
            if (!isPDF && !isTXT) {
                return interaction.reply({ content: "❌ Invalid file type. Please upload only `.pdf` or `.txt` formats.", ephemeral: true });
            }

            // Lock this reply down strictly to EPHEMERAL (Only the user sees it)
            await interaction.deferReply({ ephemeral: true });

            try {
                const response = await axios.get(attachment.url, { responseType: isPDF ? 'arraybuffer' : 'text', timeout: 15000 });
                let extractedText = isPDF ? (await pdfParse(Buffer.from(response.data))).text : response.data;
                
                let questions = parseQuestions(extractedText);
                if (questions.length === 0) {
                    return await interaction.editReply("❌ **Parsing Failure:** Could not discover cleanly structured questions.");
                }

                if (SHUFFLE_QUESTIONS) questions = shuffleArray(questions);

                // Use unique user ID + channel ID combined map keys to isolate parallel individual attempts
                const userSessionKey = `${interaction.user.id}_${interaction.channel.id}`;
                globalStorage.set(userSessionKey, { userId: interaction.user.id, questions });

                // Start the quiz directly inside the private ephemeral reply framework!
                const activeItem = questions[0];
                const firstQuestionEmbed = buildQuizEmbed(activeItem, 0, questions.length, 0, 0);
                const btnRow = new ActionRowBuilder();
                
                activeItem.originalOrder.forEach(letter => {
                    if (activeItem.options[letter]) {
                        btnRow.addComponents(new ButtonBuilder().setCustomId(`dyn_answer_0_0_${letter}`).setLabel(letter).setStyle(ButtonStyle.Secondary));
                    }
                });

                // Update the hidden message frame with the quiz questions
                await interaction.editReply({ embeds: [firstQuestionEmbed], components: [btnRow] });

            } catch (error) {
                console.error(error);
                await interaction.editReply("❌ **System Error:** Failed to cleanly ingest document buffers.").catch(() => {});
            }
        }
        return;
    }

    // B. HANDLE INTERACTIVE BUTTON PRESSES
    if (!interaction.isButton()) return;

    const channel = interaction.channel;
    const userSessionKey = `${interaction.user.id}_${interaction.channel.id}`;
    let session = globalStorage.get(userSessionKey);

    if (!session || !session.questions || session.questions.length === 0) {
        return interaction.reply({ content: "⚠️ **Session Expired:** Run `/quiz` again to start your own trial.", ephemeral: true }).catch(() => {});
    }

    try {
        await interaction.deferUpdate();
    } catch (err) {
        console.error("Defer update thread collision:", err);
        return;
    }

    const questions = session.questions;

    if (interaction.customId.startsWith('dyn_answer_')) {
        const [, , indexStr, scoreStr, chosen] = interaction.customId.split('_');
        const idx = parseInt(indexStr);
        let currentScore = parseInt(scoreStr);

        if (isNaN(idx) || isNaN(currentScore) || !questions[idx] || !chosen) return;

        const activeItem = questions[idx];
        const isCorrect = chosen === activeItem.correct;
        if (isCorrect) currentScore++;

        const evaluationEmbed = buildQuizEmbed(activeItem, idx, questions.length, currentScore, idx + 1, chosen);
        const navigationRow = new ActionRowBuilder();

        if (idx + 1 < questions.length) {
            navigationRow.addComponents(
                new ButtonBuilder().setCustomId(`dyn_next_${idx + 1}_${currentScore}`).setLabel('Next Question ➡️').setStyle(ButtonStyle.Primary)
            );
        } else {
            evaluationEmbed.addFields({ name: '🏁 Evaluation Complete!', value: `📈 Your Private Score Metric: **${currentScore} / ${questions.length}** (${Math.round((currentScore / questions.length) * 100)}%)` });
            globalStorage.delete(userSessionKey); // Wipe instance data cleanly
        }
        await interaction.message.edit({ embeds: [evaluationEmbed], components: navigationRow.components.length ? [navigationRow] : [] }).catch(console.error);

    } else if (interaction.customId.startsWith('dyn_next_')) {
        const [, , nextIndexStr, nextScoreStr] = interaction.customId.split('_');
        const index = parseInt(nextIndexStr);
        const score = parseInt(nextScoreStr);
        const activeItem = questions[index];

        if (isNaN(index) || isNaN(score) || !activeItem) return;

        const questionEmbed = buildQuizEmbed(activeItem, index, questions.length, score, index);
        const btnRow = new ActionRowBuilder();
        activeItem.originalOrder.forEach(letter => {
            if (activeItem.options[letter]) {
                btnRow.addComponents(new ButtonBuilder().setCustomId(`dyn_answer_${index}_${score}_${letter}`).setLabel(letter).setStyle(ButtonStyle.Secondary));
            }
        });
        await interaction.message.edit({ embeds: [questionEmbed], components: [btnRow] }).catch(console.error);
    }
});

client.login(TOKEN);
