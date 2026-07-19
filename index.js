const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, ApplicationCommandOptionType } = require('discord.js');
const pdfParse = require('pdf-parse');
const axios = require('axios');
const http = require('http');

// --- GLOBAL ERROR PROTECTION LAYER (Prevents Render Process Crashes) ---
process.on('uncaughtException', (error) => {
    console.log('🚨 CRITICAL UNCAUGHT EXCEPTION AUDITED:', error.stack || error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.log('🚨 UNHANDLED PROMISE REJECTION AUDITED AT:', promise, 'REASON:', reason);
});

const SHUFFLE_QUESTIONS = false;
const SHUFFLE_CHOICES = false;

// --- ENVIRONMENT VALIDATION LAYER ---
console.log('⏳ Validating system environment variables...');
const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
    console.log('❌ DEPLOYMENT CRITICAL ERROR: "DISCORD_TOKEN" is missing from your environment variables.');
    process.exit(1);
}
console.log('✅ Environment parameters verified successfully.');

// --- RUNTIME MEMORY STORAGE REGISTRIES ---
const globalStorage = new Map(); 
const sharedRooms = new Map();   

// --- PRE-COMPILED PARSER REGEXES ---
const QUESTION_START_REGEX = /^(?:(?:Question|Q|No\.|Num)\s*[:.-]?\s*\d+|\d+\s*[\.\)]\s+(?=[A-Za-z"']))/i;
const ISOLATED_YEAR_REGEX = /^(19|20)\d{2}$/;
const OPTION_START_REGEX = /^([A-D])\s*[\.\):\-\u2013\u2014]/i;
const ANSWER_KEY_REGEX = /^(?:CORRECT\s+)?ANSWER\s*[:\-\s=]+\s*[\u201C\u201D"']?([A-D])[\u201C\u201D"']?(?:\.|\b)/i;
const RATIONALE_START_REGEX = /^(?:Rationale|Explanation)\s*:\s*/i;
const ARTIFACT_REGEX = /^(?:page\s*\d+|\d+\s*\/\s*\d+|copyright|ncm\s*\d+)/i;

// NEW: Detects SATA Roman numeral criteria lines (e.g., "i. ", "iv. ", "ii) ")
const SATA_NUMERAL_REGEX = /^(i{1,3}|iv|v|vi{1,3}|ix|x)\s*[\.\)]/i;

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
            
            let cleanQuestionText = line.replace(QUESTION_START_REGEX, '').trim();
            if (cleanQuestionText.startsWith(':') || cleanQuestionText.startsWith('.') || cleanQuestionText.startsWith(')')) {
                cleanQuestionText = cleanQuestionText.substring(1).trim();
            }

            currentQuestion = {
                question: cleanQuestionText,
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
            // FIXED: If the new line is a Roman numeral item, append a newline character instead of a space
            if (SATA_NUMERAL_REGEX.test(line)) {
                currentQuestion.question += '\n' + line;
            } else {
                // If the previous text ended with a Roman numeral line, make sure the text after it splits onto a new line too
                const lastLine = currentQuestion.question.split('\n').pop();
                if (lastLine && SATA_NUMERAL_REGEX.test(lastLine.trim())) {
                    currentQuestion.question += '\n' + line;
                } else {
                    currentQuestion.question += ' ' + line;
                }
            }
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
        // Clean up double spaces but preserve explicit user line breaks (\n) for SATA formatting
        q.question = q.question.split('\n').map(segment => segment.replace(/\s+/g, ' ').trim()).join('\n');
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

function buildQuizEmbed(item, index, total, score, answeredCount, quizTitle, chosen = null, description = null) {
    const embed = new EmbedBuilder().setColor(0x3498db);

    // Build header details string
    let embedDescription = `**Question ${index + 1} of ${total}**\n\n${item.question}`;
    if (description) {
        embedDescription = `*${description}*\n\n` + embedDescription;
    }

    if (!chosen) {
        embed.setTitle(`📝 ${quizTitle}`)
            .setDescription(embedDescription)
            .setFooter({ text: `Question ${index + 1}/${total} • Current Score: ${score}/${answeredCount}` });

        item.originalOrder.forEach(letter => {
            if (item.options[letter]) {
                embed.addFields({ name: `Option ${letter}`, value: item.options[letter], inline: false });
            }
        });
    } else {
        const isCorrect = chosen === item.correct;
        
        let feedbackDescription = `**Your Verdict:** ${isCorrect ? 'Correct! 🎉' : 'Incorrect ❌'}\n\n**Question:**\n${item.question}`;
        if (description) {
            feedbackDescription = `*${description}*\n\n` + feedbackDescription;
        }

        embed.setColor(isCorrect ? 0x2ecc71 : 0xe74c3c)
            .setTitle(`📝 ${quizTitle} — Feedback`)
            .setDescription(feedbackDescription)
            .setFooter({ text: `Progress: ${index + 1} of ${total} • Score: ${score} Correct` });

        item.originalOrder.forEach(letter => {
            let label = `Option ${letter}`;
            if (letter === item.correct) label += ' (Correct ✅)';
            else if (letter === chosen) label += ' (Your Pick ❌)';
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

// --- AUTOMATIC COMMAND REGISTRATION ON BOOT ---
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
                },
                {
                    name: 'title',
                    description: 'Give this quiz session a custom title (optional)',
                    type: ApplicationCommandOptionType.String,
                    required: false
                },
                {
                    name: 'desc',
                    description: 'Brief description of topics covered (max 200 chars)',
                    type: ApplicationCommandOptionType.String,
                    required: false
                }
            ]
        },
        {
            name: 'quiz',
            description: 'Host a shared review room for everyone in the server to join.',
            options: [
                {
                    name: 'reviewer',
                    description: 'Select the shared room study file (.pdf or .txt)',
                    type: ApplicationCommandOptionType.Attachment,
                    required: true
                },
                {
                    name: 'title',
                    description: 'Give this shared room quiz a custom title (optional)',
                    type: ApplicationCommandOptionType.String,
                    required: false
                },
                {
                    name: 'desc',
                    description: 'Brief description of topics covered (max 200 chars)',
                    type: ApplicationCommandOptionType.String,
                    required: false
                }
            ]
        }
    ];

    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        console.log('⏳ Rest Routing: Synchronizing slash command configurations...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: JSON.parse(JSON.stringify(commands)) });
        console.log('✅ Success: Global application slash commands registered.');
    } catch (error) {
        console.log('⚠️ Registration Error Warning: Failed to sync commands safely:', error);
    }
});

// --- INTERACTION HANDLING HUB ---
client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            const attachment = interaction.options.getAttachment('reviewer');
            if (!attachment) return await interaction.reply({ content: '❌ Missing file attachment parameters.', ephemeral: true }).catch(console.log);

            const isPDF = attachment.name.endsWith('.pdf');
            const isTXT = attachment.name.endsWith('.txt');
            if (!isPDF && !isTXT) {
                return await interaction.reply({ content: '❌ Invalid format structure. Please supply .pdf or .txt items.', ephemeral: true }).catch(console.log);
            }

            const inputTitle = interaction.options.getString('title');
            const quizTitle = inputTitle ? inputTitle.trim() : attachment.name.replace(/\.[^/.]+$/, "");

            // Safely retrieve description and clip if it passes character boundary limit rules
            let quizDesc = interaction.options.getString('desc');
            if (quizDesc) {
                quizDesc = quizDesc.trim();
                if (quizDesc.length > 200) {
                    quizDesc = quizDesc.substring(0, 197) + '...';
                }
            }

            if (interaction.commandName === 'startquiz') {
                await interaction.deferReply({ ephemeral: true }).catch(console.log);

                try {
                    const response = await axios.get(attachment.url, { responseType: isPDF ? 'arraybuffer' : 'text', timeout: 15000 });
                    let extractedText = isPDF ? (await pdfParse(Buffer.from(response.data))).text : response.data;
                    let questions = parseQuestions(extractedText);
                    
                    if (questions.length === 0) return await interaction.editReply('❌ **Parsing Failure:** No cleanly structured items detected.').catch(console.log);
                    if (SHUFFLE_QUESTIONS) questions = shuffleArray(questions);

                    const userSessionKey = `${interaction.user.id}_${interaction.channel.id}`;
                    globalStorage.set(userSessionKey, { userId: interaction.user.id, questions, title: quizTitle, description: quizDesc });

                    const activeItem = questions[0];
                    const firstQuestionEmbed = buildQuizEmbed(activeItem, 0, questions.length, 0, 0, quizTitle, null, quizDesc);
                    const btnRow = new ActionRowBuilder();
                    
                    activeItem.originalOrder.forEach(letter => {
                        if (activeItem.options[letter]) {
                            btnRow.addComponents(new ButtonBuilder().setCustomId(`dyn_answer_0_0_${letter}`).setLabel(letter).setStyle(ButtonStyle.Secondary));
                        }
                    });

                    await interaction.editReply({ embeds: [firstQuestionEmbed], components: [btnRow] }).catch(console.log);
                } catch (error) {
                    console.log('Error handling /startquiz data ingestion:', error);
                    await interaction.editReply('❌ **System Error:** Failed to cleanly ingest private data frames.').catch(console.log);
                }
            }

            if (interaction.commandName === 'quiz') {
                await interaction.deferReply({ ephemeral: true }).catch(console.log);

                try {
                    const response = await axios.get(attachment.url, { responseType: isPDF ? 'arraybuffer' : 'text', timeout: 15000 });
                    let extractedText = isPDF ? (await pdfParse(Buffer.from(response.data))).text : response.data;
                    let questions = parseQuestions(extractedText);
                    
                    if (questions.length === 0) return await interaction.editReply("❌ **Parsing Failure:** Couldn't map structured content patterns.").catch(console.log);

                    await interaction.deleteReply().catch(console.log);

                    let roomMessageText = `**Host:** ${interaction.user}\n**Operational Items:** ${questions.length} questions loaded.\n\n`;
                    if (quizDesc) {
                        roomMessageText = `**Description:** *${quizDesc}*\n` + roomMessageText;
                    }
                    roomMessageText += `Click the portal switch below to claim your private study session.`;

                    const roomEmbed = new EmbedBuilder()
                        .setTitle(`🎯 Shared Review Room: ${quizTitle}`)
                        .setDescription(roomMessageText)
                        .setColor(0x9b59b6)
                        .setFooter({ text: 'Your personal progress and scores remain strictly private.' });

                    const joinRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('room_join_portal').setLabel('Join Quiz Module 🎯').setStyle(ButtonStyle.Primary)
                    );

                    const sentMessage = await interaction.channel.send({ embeds: [roomEmbed], components: [joinRow] }).catch(console.log);
                    
                    if (sentMessage) {
                        sharedRooms.set(sentMessage.id, { questions, title: quizTitle, description: quizDesc });
                    }
                } catch (error) {
                    console.log('Error handling public room init:', error);
                    await interaction.editReply('❌ **System Error:** Shared buffer indexing failure.').catch(console.log);
                }
            }
            return;
        }

        if (!interaction.isButton()) return;
        const channel = interaction.channel;

        if (interaction.customId === 'room_join_portal') {
            const roomData = sharedRooms.get(interaction.message.id);
            if (!roomData || !roomData.questions) {
                return await interaction.reply({ content: '⚠️ **Room Expired:** This host deck is no longer in memory.', ephemeral: true }).catch(console.log);
            }

            let assignedQuestions = [...roomData.questions];
            if (SHUFFLE_QUESTIONS) assignedQuestions = shuffleArray(assignedQuestions);

            const userSessionKey = `${interaction.user.id}_${channel.id}`;
            globalStorage.set(userSessionKey, { userId: interaction.user.id, questions: assignedQuestions, title: roomData.title, description: roomData.description });

            const activeItem = assignedQuestions[0];
            const initialEmbed = buildQuizEmbed(activeItem, 0, assignedQuestions.length, 0, 0, roomData.title, null, roomData.description);
            const choiceRow = new ActionRowBuilder();
            
            activeItem.originalOrder.forEach(letter => {
                if (activeItem.options[letter]) {
                    choiceRow.addComponents(new ButtonBuilder().setCustomId(`dyn_answer_0_0_${letter}`).setLabel(letter).setStyle(ButtonStyle.Secondary));
                }
            });

            return await interaction.reply({ embeds: [initialEmbed], components: [choiceRow], ephemeral: true }).catch(console.log);
        }

        const userSessionKey = `${interaction.user.id}_${channel.id}`;
        let session = globalStorage.get(userSessionKey);

        if (!session || !session.questions || session.questions.length === 0) {
            return await interaction.reply({ content: '⚠️ **Session Inactive:** Select an open portal entry button or activate /startquiz directly.', ephemeral: true }).catch(err => console.log("Failed to send inactive session reply:", err));
        }

        const questions = session.questions;
        const quizTitle = session.title || 'Review Session';
        const quizDesc = session.description || null;

        // Handle Answer Option Selection (A, B, C, D)
        if (interaction.customId.startsWith('dyn_answer_')) {
            const parts = interaction.customId.split('_');
            const idx = parseInt(parts[2]);
            let currentScore = parseInt(parts[3]);
            const chosen = parts[4];

            if (isNaN(idx) || isNaN(currentScore) || !questions[idx] || !chosen) return;

            const activeItem = questions[idx];
            const isCorrect = chosen === activeItem.correct;
            if (isCorrect) currentScore++;

            const evaluationEmbed = buildQuizEmbed(activeItem, idx, questions.length, currentScore, idx + 1, quizTitle, chosen, quizDesc);
            const navigationRow = new ActionRowBuilder();

            if (idx + 1 < questions.length) {
                navigationRow.addComponents(
                    new ButtonBuilder().setCustomId(`dyn_next_${idx + 1}_${currentScore}`).setLabel('Next Question ➡️').setStyle(ButtonStyle.Primary)
                );
            } else {
                evaluationEmbed.addFields({ name: '🏁 Deck Completed!', value: `📈 Private Metric Result: **${currentScore} / ${questions.length}** (${Math.round((currentScore / questions.length) * 100)}%)` });
                globalStorage.delete(userSessionKey);
            }

            await interaction.update({ 
                embeds: [evaluationEmbed], 
                components: navigationRow.components.length ? [navigationRow] : [] 
            }).catch(err => {
                console.log("❌ CRITICAL: Failed to update answer feedback:", err);
            });

        // Handle "Next Question" Navigation Triggers
        } else if (interaction.customId.startsWith('dyn_next_')) {
            const parts = interaction.customId.split('_');
            const index = parseInt(parts[2]);
            const score = parseInt(parts[3]);

            const activeItem = questions[index];
            if (isNaN(index) || isNaN(score) || !activeItem) return;

            const questionEmbed = buildQuizEmbed(activeItem, index, questions.length, score, index, quizTitle, null, quizDesc);
            const btnRow = new ActionRowBuilder();
            
            activeItem.originalOrder.forEach(letter => {
                if (activeItem.options[letter]) {
                    btnRow.addComponents(new ButtonBuilder().setCustomId(`dyn_answer_${index}_${score}_${letter}`).setLabel(letter).setStyle(ButtonStyle.Secondary));
                }
            });

            await interaction.update({ 
                embeds: [questionEmbed], 
                components: [btnRow] 
            }).catch(err => {
                console.log("❌ CRITICAL: Failed to update next question card:", err);
            });
        }
    } catch (globalEventError) {
        console.log('Caught unexpected interaction runtime bubble error:', globalEventError);
    }
});

// --- RENDER HEALTH PROTOCOL WEB SERVER LAYER ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Render Health Check Interface bound to 0.0.0.0:${PORT}`);
    
    client.login(TOKEN).then(() => {
        console.log('✅ Bot login request transmitted successfully.');
    }).catch((loginError) => {
        console.log('❌ CRITICAL ERROR: Gateway registration handshake dropped:', loginError);
        process.exit(1);
    });
});
