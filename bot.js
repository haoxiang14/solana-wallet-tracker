import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import bodyParser from 'body-parser';


dotenv.config();

// Initialize Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// Initialize Express
const app = express();
app.use(bodyParser.json());

async function updateHeliusWebhookAddresses(addresses) {
    try {
        const response = await fetch(
            `https://api.helius.xyz/v0/webhooks/5be74fcf-8bde-4cb1-8005-63c146f2a316?api-key=${process.env.HELIUS_API_KEY}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    accountAddresses: addresses,
                })
            }
        );
        const data = await response.json();
        console.log('Helius webhook updated:', data);
    } catch (error) {
        console.error('Error updating Helius webhook:', error);
        throw error;
    }
}

// Bot Configuration
const botOptions = {
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
};

// Keyboard layouts
const mainMenuKeyboard = {
    reply_markup: {
        inline_keyboard: [
            [
                { text: '➕ Add Wallet', callback_data: 'add_wallet' },
                { text: '📋 List Wallets', callback_data: 'list_wallets' }
            ],
            [
                { text: '❌ Remove Wallet', callback_data: 'remove_wallet' },
                { text: '⚙️ Settings', callback_data: 'settings' }
            ],
            [{ text: 'ℹ️ Help', callback_data: 'help' }]
        ]
    }
};

// Constants
const MESSAGES = {
    WELCOME: '👋 Welcome to the Solana Wallet Tracker!\n\n' +
            '🔍 Use the buttons below to manage your wallet subscriptions:',
    TIMEOUT: '⏰ Operation timed out. Please try again.',
    ERROR: '❌ Error processing request. Please try again.',
    NO_WALLETS: '📝 You are not monitoring any wallets.',
    SETTINGS_SOON: '⚙️ Settings feature coming soon!',
    HELP_SOON: 'ℹ️ Help section coming soon!'
};

// Database operations
const db = {

    async getAllActiveWallets() {
        const { data, error } = await supabase
            .from('wallet_subscriptions')
            .select('wallet_address')
            .eq('is_active', true)
            .distinct();

        if (error) throw error;
        return data.map(row => row.wallet_address);
    },

    async addWallet(telegramUserId, walletAddress) {
        const { data: existing } = await supabase
            .from('wallet_subscriptions')
            .select()
            .eq('telegram_user_id', telegramUserId)
            .eq('wallet_address', walletAddress)
            .eq('is_active', true)
            .single();

        if (existing) {
            throw new Error('Wallet already being monitored');
        }

        const { data, error } = await supabase
            .from('wallet_subscriptions')
            .insert([{
                telegram_user_id: telegramUserId,
                wallet_address: walletAddress,
                is_active: true
            }])
            .select();

        if (error) throw error;
        const allWallets = await this.getAllActiveWallets();
        await updateHeliusWebhookAddresses(allWallets);
        return data;
    },

    async removeWallet(telegramUserId, walletAddress) {
        const { error } = await supabase
            .from('wallet_subscriptions')
            .delete()
            .eq('telegram_user_id', telegramUserId)
            .eq('wallet_address', walletAddress);

        if (error) throw error;
        const allWallets = await this.getAllActiveWallets();
        await updateHeliusWebhookAddresses(allWallets);

    },

    async listWallets(telegramUserId) {
        const { data, error } = await supabase
            .from('wallet_subscriptions')
            .select('wallet_address')
            .eq('telegram_user_id', telegramUserId)
            .eq('is_active', true);

        if (error) throw error;
        return data.map(row => row.wallet_address);
    },

    async findUsersForWallet(walletAddress) {
        const { data, error } = await supabase
            .from('wallet_subscriptions')
            .select('telegram_user_id')
            .eq('wallet_address', walletAddress)
            .eq('is_active', true);

        if (error) throw error;
        return data.map(row => row.telegram_user_id);
    }
};

// State management
class StateManager {
    
    constructor() {
        this.states = new Map();
        this.timeouts = new Map();
    }

    setState(chatId, state, timeoutMinutes = 5) {
        this.states.set(chatId, state);
        
        // Clear existing timeout if any
        if (this.timeouts.has(chatId)) {
            clearTimeout(this.timeouts.get(chatId));
        }

        // Set new timeout
        const timeout = setTimeout(() => {
            if (this.states.get(chatId) === state) {
                this.clearState(chatId);
                bot.sendMessage(chatId, MESSAGES.TIMEOUT, mainMenuKeyboard)
                    .catch(error => console.error('Timeout message error:', error));
            }
        }, timeoutMinutes * 60 * 1000);

        this.timeouts.set(chatId, timeout);
    }

    getState(chatId) {
        return this.states.get(chatId);
    }

    clearState(chatId) {
        this.states.delete(chatId);
        if (this.timeouts.has(chatId)) {
            clearTimeout(this.timeouts.get(chatId));
            this.timeouts.delete(chatId);
        }
    }
}

// Initialize state manager
const stateManager = new StateManager();

// Bot initialization
let bot;

function initBot() {
    try {
        bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, botOptions);

        bot.setMyCommands([
            {command: 'start', description: 'Start the bot'},
            {command: 'menu', description: 'Show main menu'},
            {command: 'help', description: 'Show help'}
        ]);
        
        bot.on('polling_error', (error) => {
            console.error('Polling error:', error);
            if (!error.message.includes('ETELEGRAM: 409 Conflict')) {
                restartBot();
            }
        });

        bot.on('error', (error) => {
            console.error('Bot error:', error);
        });

        return bot.getMe()
            .then((botInfo) => {
                console.log('Bot connected successfully:', botInfo.username);
                setupBotHandlers();
            })
            .catch((error) => {
                console.error('Failed to get bot info:', error);
                restartBot();
            });
    } catch (error) {
        console.error('Bot initialization error:', error);
        restartBot();
    }
}

function restartBot() {
    console.log('Attempting to restart bot...');
    if (bot) {
        try {
            bot.stopPolling()
                .then(() => setTimeout(initBot, 5000))
                .catch(() => setTimeout(initBot, 5000));
        } catch (error) {
            setTimeout(initBot, 5000);
        }
    } else {
        setTimeout(initBot, 5000);
    }
}

async function helpCommand(ctx) {
    const commandList = Object.entries(COMMANDS)
        .map(([cmd, desc]) => `<code>/${cmd}</code> - ${desc}`)
        .join('\n');
        
    await ctx.reply(
        `Available commands:\n\n${commandList}`,
        { parse_mode: 'HTML' }
    );
}

function setupBotHandlers() {


    // Command handlers
    bot.onText(/\/start/, async (msg) => {
        try {
            await bot.sendMessage(msg.chat.id, MESSAGES.WELCOME, mainMenuKeyboard);
        } catch (error) {
            console.error('Start command error:', error);
        }
    });

    bot.onText(/\/menu/, async (msg) => {
        try {
            await bot.sendMessage(msg.chat.id, MESSAGES.WELCOME, mainMenuKeyboard);
        } catch (error) {
            console.error('Menu command error:', error);
        }
    });

    // Callback query handler
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        
        try {
            // Don't await the answer
            bot.answerCallbackQuery(query.id).catch(() => {});

            switch (query.data) {
                case 'add_wallet':
                    stateManager.setState(chatId, 'WAITING_WALLET_ADD');
                    await bot.sendMessage(chatId, '👛 Enter the wallet address you want to monitor:', 
                        { reply_markup: { force_reply: true } });
                    break;

                case 'remove_wallet':
                    stateManager.setState(chatId, 'WAITING_WALLET_REMOVE');
                    await bot.sendMessage(chatId, '👛 Enter the wallet address you want to stop monitoring:', 
                        { reply_markup: { force_reply: true } });
                    break;

                case 'list_wallets':
                    const wallets = await db.listWallets(chatId);
                   
                    await bot.sendMessage(chatId, 
                        wallets.length ? `📝 Monitored wallets:\n\n${wallets.map(w => `<code>${w}\n</code>`).join('\n')}`
                        : MESSAGES.NO_WALLETS,
                        { parse_mode: 'HTML' }
                    );
                        
                    await bot.sendMessage(chatId, MESSAGES.WELCOME, mainMenuKeyboard);
                    break;

                case 'settings':
                    await bot.sendMessage(chatId, MESSAGES.SETTINGS_SOON);
                    await bot.sendMessage(chatId, MESSAGES.WELCOME, mainMenuKeyboard);
                    break;

                case 'help':
                    const commandList = Object.entries({
                        '/start': 'Start the bot',
                        '/menu': 'Show main menu',
                        '/help': 'Show this help message'
                    }).map(([cmd, desc]) => `${cmd} - ${desc}`).join('\n');
                    
                    await bot.sendMessage(chatId, 
                        `Available Commands:\n\n${commandList}\n\nOr use the menu buttons below:`, 
                        { parse_mode: 'HTML' }
                    );
                    await bot.sendMessage(chatId, MESSAGES.WELCOME, mainMenuKeyboard);
                    break;
            }
        } catch (error) {
            console.error('Callback query error:', error);
            await bot.sendMessage(chatId, MESSAGES.ERROR, mainMenuKeyboard);
        }
    });

    // Text message handler
    bot.on('text', async (msg) => {
        const chatId = msg.chat.id;
        const state = stateManager.getState(chatId);

        if (!state) return;

        try {
            const wallet = msg.text.trim();

            if (state === 'WAITING_WALLET_ADD') {
                await db.addWallet(chatId, wallet);
                await bot.sendMessage(chatId, `✅ Now monitoring wallet: ${wallet}`);
            } else if (state === 'WAITING_WALLET_REMOVE') {
                await db.removeWallet(chatId, wallet);
                await bot.sendMessage(chatId, `❌ Stopped monitoring wallet: ${wallet}`);
            }

            await bot.sendMessage(chatId, MESSAGES.WELCOME, mainMenuKeyboard);
        } catch (error) {
            console.error('Text handler error:', error);
            await bot.sendMessage(chatId, `❌ Error: ${error.message || 'Something went wrong'}. Please try again.`);
            await bot.sendMessage(chatId, MESSAGES.WELCOME, mainMenuKeyboard);
        } finally {
            stateManager.clearState(chatId);
        }
    });
}

// Webhook handler
app.post('/webhook', async (req, res) => {
    try {
        console.log('📦 Received webhook data:', JSON.stringify(req.body, null, 2));
        const transactions = req.body;

        for (const tx of transactions) {
            if (tx.type === 'SWAP') {
                const walletMatch = tx.description.match(/^([1-9A-HJ-NP-Za-km-z]{32,44})/);

                if (walletMatch) {
                    const walletAddress = walletMatch[1];
                    console.log('Wallet address:', walletAddress); 
                    const users = await db.findUsersForWallet(walletAddress);
                    console.log('🔍 Found users for wallet:', walletAddress, users);
                    // 3. Send to each user's chatId
                    for (const userId of users) {
                        const message = formatSwapMessage(tx);
                        console.log('Sending message to user:', userId, message);
                        await bot.sendMessage(userId, message, {
                            parse_mode: 'HTML'
                        });
                    }
                }
            }
        }
        
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


function parseSwapDescription(description) {
    try {
        // Extract amounts and tokens from swap description
        const swapPattern = /swapped\s+([\d.]+)\s+(\w+)\s+for\s+([\d.]+)\s+([^\s]+)/;
        const match = description.match(swapPattern);
        console.log('Match:', match);
        if (match) {
            return {
                fromAmount: parseFloat(match[1]),
                fromToken: match[2],
                toAmount: parseFloat(match[3]),
                toToken: match[4]
            };
        }
        return null;
    } catch (error) {
        console.error('Error parsing swap description:', error);
        return null;
    }
}

function formatSwapMessage(tx) {
    const swapDetails = parseSwapDescription(tx.description);
    console.log('Swap details:', swapDetails);
    
    // Construct explorer URL once (DRY principle)
    const explorerLink = `https://solscan.io/tx/${tx.signature}`;

    if (!swapDetails) {
        return `
🔄 <b>New Swap Detected!</b>
<b>Description:</b> ${tx.description}
🔍 <a href="${explorerLink}">View on Explorer</a>`;
    }

    return `
🔄 <b>New Swap Detected!</b>

💱 <b>Swapped:</b> ${swapDetails.fromAmount} ${swapDetails.fromToken}
📥 <b>For:</b> ${swapDetails.toAmount} ${swapDetails.toToken}

🔍 <a href="${explorerLink}">View on Explorer</a>
`;
}


// Start the bot
initBot().catch(error => {
    console.error('Failed to initialize bot:', error);
    restartBot();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Received SIGINT. Cleaning up...');
    if (bot) {
        try {
            await bot.stopPolling();
        } catch (error) {
            console.error('Error stopping bot:', error);
        }
    }
    process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});