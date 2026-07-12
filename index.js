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
const globalStorage = new Map();

// --- PRE-COMPILED REGULAR EXPRESSIONS ---
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
            return await loadingMessage.edit("❌ **Parsing Failure:** Could not identify any structured multiple choice items.");
        }

        if (SHUFFLE_QUESTIONS) {
            questions = shuffleArray(questions);
        }

        globalStorage.set(message.channel.id, { userId: message.author.id, questions });

        const startEmbed = new EmbedBuilder()
            .setTitle("📚 Review Deck Loaded!")
            .setDescription(`Successfully parsed **${questions.length}** valid operational questions out of your document metadata.`)
            .setColor(0x2ecc71);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('dyn_start_quiz').setLabel('🎯 Start Quiz').setStyle(ButtonStyle.Success)
        );

        await loadingMessage.edit({ content: '', embeds: [startEmbed], components: [row] });

    } catch (error) {
        console.error("Extraction pipeline failed:", error);
        const fallbackMsg = "❌ **System Error:** Failed to read file stream.";
        if (loadingMessage) await loadingMessage.edit(fallbackMsg).catch(() => {});
        else message.reply(fallbackMsg).catch(() => {});
    }
});

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
        return interaction.reply({ content: "⚠️ **Session Inactivity Timeout:** Re-upload your source material text file.", ephemeral: true }).catch(() => {});
    }

    if (session.userId && interaction.user.id !== session.userId) {
        return interaction.reply({ 
            content: "❌ This quiz session belongs to another user. Please upload your own reviewer document.", 
            ephemeral: true 
        });
    }

    try {
        await interaction.deferUpdate();
    } catch (err) {
        console.error("Failed to defer thread operation interaction:", err);
        return;
    }

    const questions = session.questions;

    // --- TEMPORARY DEBUGGING LOGS ---
    console.log(`[DEBUG] Received customId: "${interaction.customId}"`);
    console.log(`[DEBUG] Split Array:`, interaction.customId.split('_'));

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

    } else if (interaction.customId.startsWith('dyn_answer_')) {
        // FIXED ARRAY POSITION DESTRUCTURING: [ "dyn", "answer", "index", "score", "chosen" ]
        const [, , indexStr, scoreStr, chosen] = interaction.customId.split('_');
        const idx = parseInt(indexStr);
        let currentScore = parseInt(scoreStr);
        
        console.log(`[DEBUG_ANSWER] Parsed Variables -> Index: ${idx}, Score: ${currentScore}, Chosen Option: "${chosen}"`);

        // Defensive Validation Guard
        if (isNaN(idx) || isNaN(currentScore) || !questions[idx] || !chosen) {
            console.error(`[ERROR] Invalid parameters on answer click. Index: ${indexStr}, Score: ${scoreStr}, Chosen: ${chosen}`);
            return;
        }

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
            evaluationEmbed.addFields({ name: '🏁 Final Metric Evaluation Complete!', value: `📈 Total Diagnostic Accuracy Rating: **${currentScore} / ${questions.length}** (${Math.round((currentScore / questions.length) * 100)}%)` });
        }

        await interaction.message.edit({ embeds: [evaluationEmbed], components: navigationRow.components.length ? [navigationRow] : [] }).catch(console.error);

    } else if (interaction.customId.startsWith('dyn_next_')) {
        // FIXED ARRAY POSITION DESTRUCTURING: [ "dyn", "next", "index", "score" ]
        const [, , nextIndexStr, nextScoreStr] = interaction.customId.split('_');
        const index = parseInt(nextIndexStr);
        const score = parseInt(nextScoreStr);
        
        console.log(`[DEBUG_NEXT] Parsed Variables -> Next Index: ${index}, Preserved Score: ${score}`);

        // Defensive Validation Guard
        if (isNaN(index) || isNaN(score) || !questions[index]) {
            console.error(`[ERROR] Invalid parameters on next question click. Index: ${nextIndexStr}, Score: ${nextScoreStr}`);
            return;
        }

        const activeItem = questions[index];
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
