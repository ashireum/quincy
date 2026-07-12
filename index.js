const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const pdfParse = require('pdf-parse');
const axios = require('axios');
const http = require('http');

// Configurable Feature Toggles
const SHUFFLE_QUESTIONS = false;
const SHUFFLE_CHOICES = false;

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
// Stored value shape: { userId: string, questions: Array }
const globalStorage = new Map();

// --- PRE-COMPILED REGULAR EXPRESSIONS ---
// Matches Question Starts: e.g., "1.", "1)", "Question 1", "Q1.", "No. 3" (Filters out isolated 4-digit years)
const QUESTION_START_REGEX = /^(?:(?:Question|Q|No\.)\s*)?(\d+)(?:[\.\)]|(?:\s+))?/i;
const ISOLATED_YEAR_REGEX = /^(19|20)\d{2}$/;

// Matches Option Starts: A, B, C, D followed by ., ), :, or -
const OPTION_START_REGEX = /^([A-D])\s*[\.\):\-\u2013\u2014]/i;

// Matches highly flexible Answer keys
const ANSWER_KEY_REGEX = /^(?:CORRECT\s+)?ANSWER\s*[:\-\s=]+\s*[\u201C\u201D"']?([A-D])[\u201C\u201D"']?(?:\.|\b)/i;

// Matches Rationale starts
const RATIONALE_START_REGEX = /^(?:Rationale|Explanation)\s*:\s*/i;

// Matches PDF page markers/artifacts to ignore
const ARTIFACT_REGEX = /^(?:page\s*\d+|\d+\s*\/\s*\d+|copyright|ncm\s*\d+)/i;

// --- UTILITY FUNCTIONS ---
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// --- CORE PARSER LOGIC ---
function parseQuestions(text) {
    if (!text || typeof text !== 'string') return [];

    const lines = text.split('\n').map(line => line.trim());
    const questions = [];
    let currentQuestion = null;
    let parsingStage = 'none'; // 'none', 'question', 'options', 'rationale'

    for (let line of lines) {
        if (!line || ARTIFACT_REGEX.test(line)) continue;

        // 1. Detect Question Header
        const qMatch = line.match(QUESTION_START_REGEX);
        if (qMatch && !ISOLATED_YEAR_REGEX.test(line)) {
            // Push previous question if valid (At least 2 choices found)
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

        // 2. Detect Options (Choices)
        const oMatch = line.match(OPTION_START_REGEX);
        if (oMatch) {
            const letter = oMatch[1].toUpperCase();
            currentQuestion.options[letter] = line.replace(OPTION_START_REGEX, '').trim();
            parsingStage = 'options';
            continue;
        }

        // 3. Detect Answer Keys
        const aMatch = line.match(ANSWER_KEY_REGEX);
        if (aMatch) {
            currentQuestion.correct = aMatch[1].toUpperCase();
            parsingStage = 'rationale'; // Transition phase to start collecting explanations
            continue;
        }

        // 4. Detect Explicit Rationale Flag Start
        if (RATIONALE_START_REGEX.test(line)) {
            currentQuestion.rationale = line.replace(RATIONALE_START_REGEX, '').trim();
            parsingStage = 'rationale';
            continue;
        }

        // 5. Text-Wrapping Append Strategies
        if (parsingStage === 'question') {
            currentQuestion.question += ' ' + line;
        } else if (parsingStage === 'options') {
            // Line wraps into previous option text block
            const existingLetters = Object.keys(currentQuestion.options);
            if (existingLetters.length > 0) {
                const lastLetter = existingLetters[existingLetters.length - 1];
                currentQuestion.options[lastLetter] += ' ' + line;
            }
        } else if (parsingStage === 'rationale') {
            currentQuestion.rationale += (currentQuestion.rationale ? '\n' : '') + line;
        }
    }

    // Push trailing item
    if (currentQuestion && currentQuestion.question && Object.keys(currentQuestion.options).length >= 2) {
        questions.push(currentQuestion);
    }

    // Apply Global Formatting Polish & Post-Processing Shuffles
    return questions.map(q => {
        q.question = q.question.replace(/\s+/g, ' ').trim();
        q.rationale = q.rationale.trim() || 'No specific study note provided.';
        
        let displayChoices = Object.keys(q.options).sort();
        if (SHUFFLE_CHOICES) {
            const correctText = q.options[q.correct];
            displayChoices = shuffleArray([...displayChoices]);
            
            // Re-map the correct key index seamlessly
            const newOptions = {};
            displayChoices.forEach((letter, index) => {
                const targetKey = String.fromCharCode(65 + index); // Map back to sequence A, B, C, D
                newOptions[targetKey] = q.options[letter];
                if (q.options[letter] === correctText) {
                    q.correct = targetKey;
                }
            });
            q.options = newOptions;
            displayChoices = Object.keys(newOptions).sort();
        }
        q.originalOrder = displayChoices;
        return q;
    });
}

// --- CENTRAL EMBED BUILDER COMPONENT ---
function buildQuizEmbed(item, index, total, score, answeredCount, chosen = null) {
    const embed = new EmbedBuilder().setColor(0x3498db);
    const regionalIndicators = { A: '🇦', B: '🇧', C: '🇨', D: '🇩' };

    if (!chosen) {
        // Presentation Question Panel Mode
        embed.setTitle(`📝 Question ${index + 1} of ${total}`)
            .setDescription(`**${item.question}**`)
            .setFooter({ text: `Question ${index + 1}/${total} • Current Score: ${score}/${answeredCount}` });

        item.originalOrder.forEach(letter => {
            if (item.options[letter]) {
                embed.addFields({ name: `${regionalIndicators[letter]} Option ${letter}`, value: item.options[letter], inline: false });
            }
        });
    } else {
        // Detailed Assessment Grading Screen Mode
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

client.once('ready', () => {
    console.log(`🤖 Quiz Bot is online as ${client.user.tag}!`);
});

// --- TELEMETRY MESSAGE EVENT HANDLER ---
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const attachment = message.attachments.first();
    if (!attachment) return;

    const isPDF = attachment.name.endsWith('.pdf');
    const isTXT = attachment.name.endsWith('.txt');
    if (!isPDF && !isTXT) return;

    let loadingMessage;
    try {
        loadingMessage = await message.reply(`⏳ Reading your ${isPDF ? 'PDF' : 'Text'} file and extracting questions... Please wait!`);

        const response = await axios.get(attachment.url, { 
            responseType: isPDF ? 'arraybuffer' : 'text',
            timeout: 15000 
        });

        let extractedText = "";
        if (isPDF) {
            const data = await pdfParse(Buffer.from(response.data));
            extractedText = data.text;
        } else {
            extractedText = response.data;
        }

        let questions = parseQuestions(extractedText);
        if (questions.length === 0) {
            return await loadingMessage.edit("❌ **Parsing Failure:** Could not identify any structured multiple choice items. Verify option lines match `A.` or `A)` templates and have matching `ANSWER:` keys under choices.");
        }

        if (SHUFFLE_QUESTIONS) {
            questions = shuffleArray(questions);
        }

        // Cache session securely bounded by originating User Context
        globalStorage.set(message.channel.id, { userId: message.author.id, questions });

        const startEmbed = new EmbedBuilder()
            .setTitle("📚 Review Deck Loaded!")
            .setDescription(`Successfully parsed **${questions.length}** valid operational questions out of your document metadata.\n\nPress the activation switch below to trigger your personal evaluation module.`)
            .setColor(0x2ecc71);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('dyn_start_quiz').setLabel('🎯 Start Quiz').setStyle(ButtonStyle.Success)
        );

        await loadingMessage.edit({ content: '', embeds: [startEmbed], components: [row] });

    } catch (error) {
        console.error("Extraction pipeline failed:", error);
        const fallbackMsg = "❌ **System Error:** Failed to read file stream. Check file composition formats or underlying storage corruption.";
        if (loadingMessage) await loadingMessage.edit(fallbackMsg).catch(() => {});
        else message.reply(fallbackMsg).catch(() => {});
    }
});

// --- INTERACTION COMPONENT INTERCEPTOR ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const channel = interaction.channel;
    let session = globalStorage.get(channel.id);

    // AUTO-RESTORE TRACKER ROUTINE
    if (!session || !session.questions || session.questions.length === 0) {
        try {
            const messages = await channel.messages.fetch({ limit: 15 });
            const targetMessage = messages.find(m => {
                const att = m.attachments.first();
                return att && (att.name.endsWith('.pdf') || att.name.endsWith('.txt'));
            });

            if (targetMessage) {
                const attachment = targetMessage.attachments.first();
                const isPDF = attachment.name.endsWith('.pdf');
                const response = await axios.get(attachment.url, { responseType: isPDF ? 'arraybuffer' : 'text', timeout: 10000 });
                let extractedText = isPDF ? (await pdfParse(Buffer.from(response.data))).text : response.data;
                
                let restoredQuestions = parseQuestions(extractedText);
                if (SHUFFLE_QUESTIONS) restoredQuestions = shuffleArray(restoredQuestions);

                if (restoredQuestions.length > 0) {
                    session = { userId: targetMessage.author.id, questions: restoredQuestions };
                    globalStorage.set(channel.id, session);
                }
            }
        } catch (e) {
            console.error("Automated session re-hydration sequence failed:", e);
        }
    }

    if (!session || !session.questions || session.questions.length === 0) {
        return interaction.reply({ content: "⚠️ **Session Inactivity Timeout:** Re-upload your source material text file to sync active parameters.", ephemeral: true }).catch(() => {});
    }

    // MULTI-USER OPERATION INTERCEPTOR GUARD
    if (session.userId && interaction.user.id !== session.userId) {
        return interaction.reply({ 
            content: "❌ This quiz session belongs to another user. Please upload your own reviewer document to initiate an independent training deck.", 
            ephemeral: true 
        });
    }

    // Safely defer update to hold the channel socket window
    try {
        await interaction.deferUpdate();
    } catch (err) {
        console.error("Failed to defer thread operation interaction:", err);
        return;
    }

    const questions = session.questions;

    // SCENARIO 1: Fire first dynamic card
    if (interaction.customId === 'dyn_start_quiz') {
        const activeItem = questions[0];
        const embed = buildQuizEmbed(activeItem, 0, questions.length, 0, 0);

        const btnRow = new ActionRowBuilder();
        activeItem.originalOrder.forEach(letter => {
            if (activeItem.options[letter]) {
                btnRow.addComponents(new ButtonBuilder().setCustomId(`dyn_answer_0_0_${letter}`).setLabel(letter).setStyle(ButtonStyle.Secondary));
            }
        });

        await interaction.message.edit({ embeds: [embed], components: [btnRow] }).catch(console.error);

    // SCENARIO 2: Grade targeted multiple choice selection indices
    } else if (interaction.customId.startsWith('dyn_answer_')) {
        const [, indexStr, scoreStr, chosen] = interaction.customId.split('_');
        const idx = parseInt(indexStr);
        let currentScore = parseInt(scoreStr);
        const activeItem = questions[idx];

        if (!activeItem) return;

        const isCorrect = chosen === activeItem.correct;
        if (isCorrect) currentScore++;

        const evaluationEmbed = buildQuizEmbed(activeItem, idx, questions.length, currentScore, idx + 1, chosen);
        const navigationRow = new ActionRowBuilder();

        if (idx + 1 < questions.length) {
            navigationRow.addComponents(
                new ButtonBuilder().setCustomId(`dyn_next_${idx + 1}_${currentScore}`).setLabel('Next Question ➡️').setStyle(ButtonStyle.Primary)
            );
        } else {
            evaluationEmbed.addFields({ name: '🏁 Final Metric Evaluation Complete!', value: `📈 Total Diagnostic Accuracy Rating: **${currentScore} / ${questions.length}** (${Math.round((currentScore / questions.length) * 100)}%)` });
        }

        await interaction.message.edit({ embeds: [evaluationEmbed], components: navigationRow.components.length ? [navigationRow] : [] }).catch(console.error);

    // SCENARIO 3: Pull next card layout from cached sequence maps
    } else if (interaction.customId.startsWith('dyn_next_')) {
        const [, nextIndexStr, nextScoreStr] = interaction.customId.split('_');
        const index = parseInt(nextIndexStr);
        const score = parseInt(nextScoreStr);
        const activeItem = questions[index];

        if (!activeItem) return;

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
