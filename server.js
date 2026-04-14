require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname)));

// Signals that Claude should embed in its reply when the customer disconnects.
const DISCONNECT_SIGNALS = ['[[DISCONNECT]]', '[[ניתוק]]'];

function detectDisconnect(text) {
    return DISCONNECT_SIGNALS.some(sig => text.includes(sig));
}

function stripDisconnectSignal(text) {
    let cleaned = text;
    for (const sig of DISCONNECT_SIGNALS) {
        cleaned = cleaned.replaceAll(sig, '');
    }
    return cleaned.trim();
}

app.post('/api/chat', async (req, res) => {
    const { messages, systemPrompt } = req.body;

    if (!Array.isArray(messages) || typeof systemPrompt !== 'string' || !systemPrompt) {
        return res.status(400).json({ error: 'בקשה לא תקינה' });
    }

    // Trim to last 30 turns to control token costs.
    const trimmedMessages = messages.slice(-30);

    try {
        const response = await client.messages.create({
            model: 'claude-opus-4-5',
            max_tokens: 300,
            system: systemPrompt,
            messages: trimmedMessages
        });

        const rawText = (response.content[0]?.text || '').trim();
        const disconnect = detectDisconnect(rawText);
        const reply = stripDisconnectSignal(rawText);

        res.json({ reply, disconnect });
    } catch (err) {
        console.error('[Claude API error]', err.message);
        res.status(502).json({ error: 'שירות ה-AI אינו זמין כרגע' });
    }
});

// Catch-all: serve home.html for unknown routes so deep links work.
app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'home.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🔴 HOT Mobile Trainer — http://localhost:${PORT}\n`);
});
