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
            `https://api.helius.xyz/v0/webhooks/${process.env.HELIUS_WH_ID}?api-key=${process.env.HELIUS_API_KEY}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    webhookURL: process.env.WEBHOOK_URL,
                    transactionTypes: [
                      "Any"
                    ],
                    accountAddresses: addresses,
                    webhookType: "enhanced"
                }),
            }
        );
        const data = await response.json();
        // console.log('Helius webhook updated:', data);
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

const WHITELIST = [
    5001628872
]

// Database operations
const db = {

    async getAllActiveWallets() {
        const { data, error } = await supabase
            .from('wallet_subscriptions')
            .select('wallet_address', { distinct : true })
            .eq('is_active', true)

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
        // console.log('All wallets:', allWallets);
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
            if (!WHITELIST.includes(msg.from.id)) {
                await bot.sendMessage(msg.chat.id, '⛔ Access denied. You are not authorized.');
                return;
            }
            await bot.sendMessage(msg.chat.id, MESSAGES.WELCOME, mainMenuKeyboard);
        } catch (error) {
            console.error('Start command error:', error);
        }
    });

    bot.onText(/\/menu/, async (msg) => {
        try {
            if (!WHITELIST.includes(msg.from.id)) {
                await bot.sendMessage(msg.chat.id, '⛔ Access denied. You are not authorized.');
                return;
            }
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

app.post('/webhook', async (req, res) => {
    try {
        const transactions = req.body;
        console.log('Received transactions:', transactions);

        for (const tx of transactions) {
            if (tx.type === 'SWAP') {
                const walletMatch = tx.description.match(/^([1-9A-HJ-NP-Za-km-z]{32,44})/);
                
                // Skip if no wallet match
                if (!walletMatch) continue;
                
                try {
                    const tokenTransfers = tx.tokenTransfers;
                    const fromToken = tokenTransfers[0].mint;
                    const toToken = tokenTransfers[1].mint;
                    // console.log('Token transfers:', fromToken, toToken);

                    // Determine which token to fetch data for
                    const tokenContract = fromToken === 'So11111111111111111111111111111111111111112'
                        ? toToken 
                        : fromToken;

                    // Fetch token data
                    const tokenData = await getTokenInfo(tokenContract);

                    const solanaData = await getTokenInfo('So11111111111111111111111111111111111111112');
                    // console.log('Token data:', tokenData);

                    if (!tokenData) {
                        console.error('Failed to fetch token data for:', tokenContract);
                        continue;
                    }

                    const walletAddress = walletMatch[1];
                    const users = await db.findUsersForWallet(walletAddress);

                    // Format message once outside the user loop
                    const formattedMessage = formatSwapMessage(tx, tokenData, solanaData);

                    // Send to each subscribed user
                    for (const userId of users) {
                        try {
                            await bot.sendMessage(
                                userId, 
                                formattedMessage.text, 
                                formattedMessage.options
                            );
                        } catch (sendError) {
                            console.error(`Failed to send message to user ${userId}:`, sendError);
                            // Continue with next user even if one fails
                            continue;
                        }
                    }
                } catch (txError) {
                    console.error('Error processing transaction:', txError);
                    // Continue with next transaction even if one fails
                    continue;
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
        const swapPattern = /(\w+)\s+swapped\s+([\d.]+)\s+(\w+)\s+for\s+([\d.]+)\s+([^\s]+)/;
        const match = description.match(swapPattern);
        // console.log(match);
        if (match) {
            return {
                address : match[1],
                fromAmount: parseFloat(match[2]),
                fromToken: match[3],
                toAmount: parseFloat(match[4]),
                toToken: match[5]
            };
        }
        return null;
    } catch (error) {
        console.error('Error parsing swap description:', error);
        return null;
    }
}

async function getTokenInfo(contractAddress) {
    try {
        const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${contractAddress}`);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching token data:', error);
        return null;
    }
}

function convertToNumber(value) {
    // Remove any commas from string numbers and convert to float
    if (typeof value === 'string') {
        value = value.replace(/,/g, '');
    }
    const num = Number(value);
    return isNaN(num) ? 0 : num;
}

function formatNumber(value) {
    // Convert string to number first
    const num = convertToNumber(value);
    
    if (num === 0) return '0';
    
    try {
        if (num >= 1000000) {
            return `${(num / 1000000).toFixed(2)}M`;
        } else if (num >= 1000) {
            return `${(num / 1000).toFixed(2)}K`;
        }
        return num.toFixed(2);
    } catch (error) {
        console.error('Error formatting number:', error);
        return '0';
    }
}

function padValue (value, length) {
    return value.toString().padEnd(length, ' ');
};


function formatSwapMessage(tx, tokenData, solanaData) {
    const swapDetails = parseSwapDescription(tx.description);
    // console.log('Swap details:', swapDetails);

    // Early validation check
    if (!swapDetails) {
        const explorerLink = `https://solscan.io/tx/${tx.signature}`;
        return {
            text: `
🔄 <b>New Swap Detected!</b>
<b>Description:</b> ${tx.description}
🔍 <a href="${explorerLink}">View on Explorer</a>`,
            options: {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            }
        };
    }

    // Safely access token data
    const token = tokenData?.data?.attributes;
    const solana = solanaData?.data?.attributes;
    if (!token) {
        console.error('Token data is missing or invalid');
        return {
            text: '❌ Error: Invalid token data',
            options: { parse_mode: 'HTML' }
        };
    }

    // Create all links
    const explorerLink = `https://solscan.io/tx/${tx.signature}`;
    const gmgnLink = `https://gmgn.ai/sol/address/${swapDetails.address}`;
    const gmgnTokenLink = `https://gmgn.ai/sol/token/${token.address}`;
    const GTLink = `https://www.geckoterminal.com/solana/tokens/${token.address}`;
    const LYTBotBuy = `https://t.me/LeYeetbot?start=buy_${token.address}`;
    const LYTBotSell = `https://t.me/LeYeetbot?start=sell_${token.address}`;
    const rugcheck = `https://rugcheck.xyz/tokens/${token.address}`;
    const shortAddress = `${swapDetails.address.slice(0, 6)}...${swapDetails.address.slice(-4)}`;
    const fees = tx.fee/1000000000;
    // Format numbers
    const price = token.price_usd;
    const mc = formatNumber(token.fdv_usd);
    const volume = formatNumber(token.volume_usd?.h24);

    // Handle token symbols
    let fromToken = swapDetails.fromToken;
    let toToken = swapDetails.toToken;
    let swapMessage;
    let fromTokenValue 
    let toTokenValue


    if (fromToken === 'SOL') {
        toToken = token.symbol;
        swapMessage = "Buy Detected!";
        fromTokenValue = swapDetails.fromAmount*solana.price_usd;
        toTokenValue = swapDetails.toAmount*price
    } else if (toToken === 'SOL') {
        fromToken = token.symbol;
        fromTokenValue = swapDetails.fromAmount*token.price_usd;
        toTokenValue = swapDetails.toAmount*solana.price_usd
        swapMessage = "Sell Detected!";
    }


    //format pad
    const formattedWallet = padValue(`${shortAddress}`, 40);
    const formattedSwapped = padValue(`<b>💱 Swapped:</b> ${formatNumber(swapDetails.fromAmount)} ${fromToken} ($${(fromTokenValue).toFixed(2)})`, 40);
    const formattedFor = padValue(`<b>📥 For:</b> ${formatNumber(swapDetails.toAmount)} ${toToken} ($${(toTokenValue).toFixed(2)})`, 40);
    const formattedPrice = padValue(`<b>Price:</b> $${price}`, 20);
    const formattedMC = padValue(`<b>MC:</b> $${mc}`, 20);
    const formattedVolume = padValue(`<b>24h Vol:</b> $${volume}`, 20);

    const message = `
🔄 <b>${swapMessage}</b>

<b>💳 Wallet:</b> <a href="${gmgnLink}">${formattedWallet}</a>
${formattedSwapped} 
${formattedFor}
<b>💰 Fees:</b> ${fees} SOL ($${(fees*solana.price_usd).toFixed(4)})

<a href="${gmgnTokenLink}">$${token.symbol?.toUpperCase() || 'UNKNOWN'}</a>
${formattedPrice}
${formattedMC}
${formattedVolume}
`;

    return {
        text: message,
        options: {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🔎 Explorer', url: explorerLink },
                        { text: '🦖 GMGN', url: gmgnTokenLink }
                    ],
                    [
                        { text: '📈 Chart', url: GTLink },
                        { text: '😈 Rug Check', url: rugcheck }
                    ],
                    [
                        { text: '💰 Buy', url: LYTBotBuy },
                        { text: '💸 Sell', url: LYTBotSell }
                    ]
                ]
            }
        }
    };
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
