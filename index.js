const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, ApplicationCommandOptionType } = require('discord.js');
const pdfParse = require('pdf-parse');
const axios = require('axios');
const http = require('http');

// --- GLOBAL ERROR PROTECTION LAYER (Prevents Render Process Crashes) ---
process.on('uncaughtException', (error) => {
    console.error('🚨 CRITICAL UNCAUGHT EXCEPTION AUDITED:', error.stack || error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 UNHANDLED PROMISE REJECTION AUDITED AT:', promise, 'REASON:', reason);
});

const SHUFFLE_QUESTIONS = false;
const SHUFFLE_CHOICES = false;

// --- ENVIRONMENT VALIDATION LAYER ---
console.log('⏳ Validating system environment variables...');
const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
    console.error('❌ DEPLOYMENT CRITICAL ERROR: "DISCORD_TOKEN" is missing from your environment variables.');
    process.exit(1);
}
console.log('✅ Environment parameters verified successfully.');

// --- RUNTIME MEMORY STORAGE REGISTRIES ---
const globalStorage = new Map(); 
const sharedRooms = new Map();   

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
    const regionalIndicators = { A: 'A', B: 'B', C: 'C', D: 'D' };

    if (!chosen) {
        embed.setTitle(`Question ${index + 1} of ${total}`)
            .setDescription(`**${item.question}**`)
            .setFooter({ text: `Question ${index + 1}/${total} • Current Score: ${score}/${answeredCount}` });

        item.originalOrder.forEach(letter => {
            if (item.options[letter]) {
                embed.addFields({ name: `Option ${letter}`, value: item.options[letter], inline: false });
            }
        });
    } else {
        const isCorrect = chosen === item.correct;
        embed.setColor(isCorrect ? 0x2ecc71 : 0xe74c3c)
            .setTitle(`Question ${index + 1} Feedback`)
            .setDescription(`**Your Verdict:** ${isCorrect ? 'Correct!' : 'Incorrect'}\n\n**Question:**\n${item.question}`)
            .setFooter({ text: `Progress: ${index + 1} of ${total} • Score: ${score} Correct` });

        item.originalOrder.forEach(letter => {
            let label = `Option ${letter}`;
            if (letter === item.correct) label += ' (Correct)';
            else if (letter === chosen) label += ' (Your Pick)';
            if (item.options[letter]) {
                embed.addFields({ name: label, value: item.options[letter], inline: false });
            }
        });
        embed.addFields({ name: 'Rationale & Clinical Notes', value: item.rationale, inline: false });
    }
    return embed;
}

// --- INITIALIZE CLIENT INSTANCE ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// --- AUTOMATIC COMMAND REGISTRATION ON BOOT (Safely Wrapped to Prevent Deploy Freezes) ---
client.once('ready', async () => {
    console.log(`🤖 Discord Gateway Connected! Active session user: ${client.user.tag}`);

    const commands = [
        {
            name: 'startquiz',
            description: 'Start a private solo quiz session using a personal document.',
            options: [
                {
                    name: 'reviewer',
                    description: 'Select your study file (.pdf or .txt)',
                    type: ApplicationCommandOptionType.Attachment,
                    required: true
                }
            ]
        },
        {
            name: 'quiz',
            description: 'Host a public review room. Only server owners/admins can launch this.',
            default_member_permissions: "32", 
            options: [
                {
                    name: 'reviewer',
                    description: 'Select the shared room study file (.pdf or .txt)',
                    type: ApplicationCommandOptionType.Attachment,
                    required: true
                }
            ]
        }
    ];

    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        console.log('⏳ Rest Routing: Synchronizing slash command configurations...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Success: Global application slash commands registered.');
    } catch (error) {
        console.error('⚠️ Registration Error Warning: Failed to sync commands, using cached schema:', error);
    }
});

// --- INTERACTION HANDLING HUB ---
client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            const attachment = interaction.options.getAttachment('reviewer');
            if (!attachment) return await interaction.reply({ content: '❌ Missing file attachment parameters.', ephemeral: true }).catch(console.error);

            const isPDF = attachment.name.endsWith('.pdf');
            const isTXT = attachment.name.endsWith('.txt');
            if (!isPDF && !isTXT) {
                return await interaction.reply({ content: '❌ Invalid format structure. Please supply .pdf or .txt items.', ephemeral: true }).catch(console.error);
            }

            if (interaction.commandName === 'startquiz') {
                await interaction.deferReply({ ephemeral: true }).catch(console.error);

                try {
                    const response = await axios.get(attachment.url, { responseType: isPDF ? 'arraybuffer' : 'text', timeout: 15000 });
                    let extractedText = isPDF ? (await pdfParse(Buffer.from(response.data))).text : response.data;
                    let questions = parseQuestions(extractedText);
                    
                    if (questions.length === 0) return await interaction.editReply('❌ **Parsing Failure:** No cleanly structured items detected.').catch(console.error);
                    if (SHUFFLE_QUESTIONS) questions = shuffleArray(questions);

                    const userSessionKey = `${interaction.user.id}_${interaction.channel.id}`;
                    globalStorage.set(userSessionKey, { userId: interaction.user.id, questions });

                    const activeItem = questions[0];
                    const firstQuestionEmbed = buildQuizEmbed(activeItem, 0, questions.length, 0, 0);
                    const btnRow = new ActionRowBuilder();
                    
                    activeItem.originalOrder.forEach(letter => {
                        if (activeItem.options[letter]) {
                            btnRow.addComponents(new ButtonBuilder().setCustomId(`dyn_answer_0_0_${letter}`).setLabel(letter).setStyle(ButtonStyle.Secondary));
                        }
                    });

                    await interaction.editReply({ embeds: [firstQuestionEmbed], components: [btnRow] }).catch(console.error);
                } catch (error) {
                    console.error('Error handling /startquiz data ingestion:', error);
                    await interaction.editReply('❌ **System Error:** Failed to cleanly ingest private data frames.').catch(console.error);
                }
            }

            if (interaction.commandName === 'quiz') {
                await interaction.deferReply({ ephemeral: true }).catch(console.error);

                try {
                    const response = await axios.get(attachment.url, { responseType: isPDF ? 'arraybuffer' : 'text', timeout: 15000 });
                    let extractedText = isPDF ? (await pdfParse(Buffer.from(response.data))).text : response.data;
                    let questions = parseQuestions(extractedText);
                    
                    if (questions.length === 0) return await interaction.editReply("❌ **Parsing Failure:** Couldn't map structured content patterns.").catch(console.error);

                    sharedRooms.set(interaction.channel.id, { questions });
                    await interaction.deleteReply().catch(console.error);

                    const roomEmbed = new EmbedBuilder()
                        .setTitle('🎯 Active Review Deck Initialized!')
                        .setDescription(`**Host:** ${interaction.user}\n**Operational Items:** ${questions.length} questions loaded.\n\nClick the invitation portal switch below to claim your private instance tracking profile.`)
                        .setColor(0x9b59b6)
                        .setFooter({ text: 'Progress loops are strictly individual and isolated from public view.' });

                    const joinRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('room_join_portal').setLabel('Join Quiz Module 🎯').setStyle(ButtonStyle.Primary)
                    );

                    await interaction.channel.send({ embeds: [roomEmbed], components: [joinRow] }).catch(console.error);
                } catch (error) {
                    console.error('Error handling public room init:', error);
                    await interaction.editReply('❌ **System Error:** Shared buffer indexing failure.').catch(console.error);
                }
            }
            return;
        }

        if (!interaction.isButton()) return;
        const channel = interaction.channel;

        if (interaction.customId === 'room_join_portal') {
            const roomData = sharedRooms.get(channel.id);
            if (!roomData || !roomData.questions) {
                return await interaction.reply({ content: '⚠️ **Room Expired:** The host deck has left the memory registry. Please rebuild.', ephemeral: true }).catch(console.error);
            }

            let assignedQuestions = [...roomData.questions];
            if (SHUFFLE_QUESTIONS) assignedQuestions = shuffleArray(assignedQuestions);

            const userSessionKey = `${interaction.user.id}_${channel.id}`;
            globalStorage.set(userSessionKey, { userId: interaction.user.id, questions: assignedQuestions });

            const activeItem = assignedQuestions[0];
            const initialEmbed = buildQuizEmbed(activeItem, 0, assignedQuestions.length, 0, 0);
            const choiceRow = new ActionRowBuilder();
            
            activeItem.originalOrder.forEach(letter => {
                if (activeItem.options[letter]) {
                    choiceRow.addComponents(new ButtonBuilder().setCustomId(`dyn_answer_0_0_${letter}`).setLabel(letter).setStyle(ButtonStyle.Secondary));
                }
            });

            return await interaction.reply({ embeds: [initialEmbed], components: [choiceRow], ephemeral: true }).catch(console.error);
        }

        const userSessionKey = `${interaction.user.id}_${channel.id}`;
        let session = globalStorage.get(userSessionKey);

        if (!session || !session.questions || session.questions.length === 0) {
            return await interaction.reply({ content: '⚠️ **Session Inactive:** Select an open portal entry button or activate /startquiz directly.', ephemeral: true }).catch(console.error);
        }

        try {
            await interaction.deferUpdate();
        } catch (err) {
            console.error('Interaction runtime race exception captured:', err);
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
                evaluationEmbed.addFields({ name: '🏁 Deck Completed!', value: `📈 Private Metric Result: **${currentScore} / ${questions.length}** (${Math.round((currentScore / questions.length) * 100)}%)` });
                globalStorage.delete(userSessionKey);
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
    } catch (globalEventError) {
        console.error('Caught unexpected interaction runtime bubble error:', globalEventError);
    }
});

// --- RENDER HEALTH PROTOCOL WEB SERVER LAYER ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Render Health Check Interface bound to 0.0.0.0:${PORT}`);
    
    // Establishing gateway stream interface once server bindings clear
    client.login(TOKEN).then(() => {
        console.log('✅ Bot login request transmitted successfully.');
    }).catch((loginError) => {
        console.error('❌ CRITICAL ERROR: Gateway registration handshake dropped:', loginError);
        process.exit(1);
    });
});
