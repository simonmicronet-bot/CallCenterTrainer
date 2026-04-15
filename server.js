require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: '12mb' }));
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

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function scoreLowerIsBetter(value, target) {
    if (target <= 0) return value <= 0 ? 1 : 0;
    if (value <= target) return 1;
    return clamp01(target / value);
}

function scoreHigherIsBetter(value, target) {
    if (target <= 0) return 1;
    return clamp01(value / target);
}

function scoreRange(value, minTarget, maxTarget) {
    if (minTarget > maxTarget) return 0;
    if (value >= minTarget && value <= maxTarget) return 1;
    if (value < minTarget) return minTarget > 0 ? clamp01(value / minTarget) : 0;
    return value > 0 ? clamp01(maxTarget / value) : 0;
}

function computeScriptScore(analysis) {
    const openingConfigured = Boolean(analysis.openingScriptConfigured);
    const closingConfigured = Boolean(analysis.closingScriptConfigured);

    if (!openingConfigured && !closingConfigured) return { score: 0.5, available: false };

    const parts = [];
    if (openingConfigured) parts.push(analysis.openingScriptUsed === true ? 1 : 0);
    if (closingConfigured) parts.push(analysis.closingScriptUsed === true ? 1 : 0);

    return {
        score: parts.reduce((a, b) => a + b, 0) / parts.length,
        available: true
    };
}

function buildReportComponents(analysis, settings, weights) {
    const scriptData = computeScriptScore(analysis);
    return [
        {
            key: 'duration',
            label: 'Duration',
            icon: 'DUR',
            weight: Number(weights.duration || 0),
            score: scoreLowerIsBetter(Number(analysis.durationSeconds || 0), Number(settings.targetConversationDuration || 0)),
            available: true,
            actual: analysis.durationLabel || `${analysis.durationSeconds || 0}s`,
            target: `${settings.targetConversationDuration || 0}s or less`
        },
        {
            key: 'disconnectedBy',
            label: 'Customer Disconnect',
            icon: 'DISC',
            weight: Number(weights.disconnectedBy || 0),
            score: analysis.disconnectedBy === 'הלקוח' ? 0 : 1,
            available: true,
            actual: analysis.disconnectedBy || '-',
            target: 'Not disconnected by customer'
        },
        {
            key: 'averageResponse',
            label: 'Average Response',
            icon: 'AVG',
            weight: Number(weights.averageResponse || 0),
            score: scoreLowerIsBetter(Number(analysis.averageResponseSeconds || 0), Number(settings.targetAvgResponse || 0)),
            available: Boolean(analysis.hasAverageResponseMetric),
            actual: analysis.averageResponseLabel || '-',
            target: `${settings.targetAvgResponse || 0}s or less`
        },
        {
            key: 'maxResponse',
            label: 'Max Response',
            icon: 'MAX',
            weight: Number(weights.maxResponse || 0),
            score: scoreLowerIsBetter(Number(analysis.maxResponseSeconds || 0), Number(settings.targetMaxResponse || 0)),
            available: Boolean(analysis.hasMaxResponseMetric),
            actual: analysis.maxResponseLabel || '-',
            target: `${settings.targetMaxResponse || 0}s or less`
        },
        {
            key: 'politeness',
            label: 'Politeness',
            icon: 'POL',
            weight: Number(weights.politeness || 0),
            score: scoreHigherIsBetter(Number(analysis.politenessCount || 0), Number(settings.targetPolitenessCount || 0)),
            available: true,
            actual: analysis.politenessLabel || `${analysis.politenessCount || 0}`,
            target: `${settings.targetPolitenessCount || 0} or more`
        },
        {
            key: 'nameAddress',
            label: 'Name Usage',
            icon: 'NAME',
            weight: Number(weights.nameAddress || 0),
            score: scoreHigherIsBetter(Number(analysis.nameAddressCount || 0), Number(settings.targetNameAddressCount || 0)),
            available: true,
            actual: analysis.nameAddressLabel || `${analysis.nameAddressCount || 0}`,
            target: `${settings.targetNameAddressCount || 0} or more`
        },
        {
            key: 'longPause',
            label: 'Long Pauses',
            icon: 'PAUSE',
            weight: Number(weights.longPause || 0),
            score: scoreLowerIsBetter(Number(analysis.longPauseCount || 0), Number(settings.targetLongPauseCount || 0)),
            available: true,
            actual: analysis.longPauseLabel || `${analysis.longPauseCount || 0}`,
            target: `${settings.targetLongPauseCount || 0} max`
        },
        {
            key: 'ratio',
            label: 'Agent/Customer Ratio',
            icon: 'RATIO',
            weight: Number(weights.ratio || 0),
            score: scoreRange(Number(analysis.agentCustomerRatio || 0), Number(settings.targetMinAgentCustomerRatio || 0), Number(settings.targetMaxAgentCustomerRatio || 0)),
            available: Boolean(analysis.hasMessageRatioMetric),
            actual: analysis.agentCustomerRatioLabel || '-',
            target: `${settings.targetMinAgentCustomerRatio || 0} - ${settings.targetMaxAgentCustomerRatio || 0}`
        },
        {
            key: 'script',
            label: 'Script Compliance',
            icon: 'SCR',
            weight: Number(weights.script || 0),
            score: scriptData.score,
            available: scriptData.available,
            actual: analysis.scriptComplianceLabel || '-',
            target: 'Opening/closing script match'
        },
        {
            key: 'repeatedIssue',
            label: 'Repeated Issue',
            icon: 'REP',
            weight: Number(weights.repeatedIssue || 0),
            score: scoreLowerIsBetter(Number(analysis.repeatedIssueCount || 0), Number(settings.targetMaxRepeatedIssueCount || 0)),
            available: true,
            actual: analysis.repeatedIssueLabel || `${analysis.repeatedIssueCount || 0}`,
            target: `${settings.targetMaxRepeatedIssueCount || 0} max`
        },
        {
            key: 'additionalHelp',
            label: 'Additional Help',
            icon: 'HELP',
            weight: Number(weights.additionalHelp || 0),
            score: analysis.offeredAdditionalHelp ? 1 : 0,
            available: true,
            actual: analysis.offeredAdditionalHelpLabel || (analysis.offeredAdditionalHelp ? 'Yes' : 'No'),
            target: 'Yes'
        },
        {
            key: 'customerIdentification',
            label: 'Customer Identification',
            icon: 'ID',
            weight: Number(weights.customerIdentification || 0),
            score: analysis.customerIdentificationRequested ? 1 : 0,
            available: true,
            actual: analysis.customerIdentificationLabel || (analysis.customerIdentificationRequested ? 'Yes' : 'No'),
            target: 'Yes'
        }
    ];
}

function computeFinalScore(components) {
    const available = components.filter((c) => c.available);
    const usedWeight = available.reduce((sum, c) => sum + c.weight, 0);
    const weightedSum = available.reduce((sum, c) => sum + c.score * c.weight, 0);
    const normalized = usedWeight > 0 ? weightedSum / usedWeight : 0;
    const score100 = Math.round(normalized * 100);
    return { score100, usedWeight };
}

function buildPdfBuffer({ analysis, settings, weights }) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        const chunks = [];

        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const components = buildReportComponents(analysis, settings, weights);
        const final = computeFinalScore(components);

        doc.fontSize(18).text('Conversation Performance Report', { align: 'left' });
        doc.moveDown(0.2);
        doc.fontSize(10).fillColor('#666').text(`Generated: ${new Date().toISOString()}`);
        doc.fillColor('#000');
        doc.moveDown(0.8);

        doc.fontSize(13).text('Full Analysis');
        doc.moveDown(0.3);
        doc.fontSize(10).text(`Agent: ${analysis.agentFirstName || '-'}`);
        doc.text(`Domain: ${analysis.professionalDomainLabel || '-'}`);
        doc.text(`Direction: ${analysis.conversationDirectionLabel || '-'}`);
        doc.text(`Difficulty: ${analysis.scenarioDifficultyLabel || '-'}`);
        doc.text(`Customer type: ${analysis.customerType || '-'}`);
        doc.moveDown(0.6);

        doc.fontSize(11).text('Metric details (Actual / Target / Score):');
        doc.moveDown(0.2);
        doc.fontSize(9);

        components.forEach((c) => {
            const scoreLabel = c.available ? `${Math.round(c.score * 100)}%` : 'N/A';
            const line = `${c.icon} ${c.label} | Weight ${c.weight}% | Actual: ${c.actual} | Target: ${c.target} | Score: ${scoreLabel}`;
            doc.text(line, { lineGap: 2 });
        });

        doc.moveDown(0.9);
        doc.fontSize(13).text('Compact Analysis');
        doc.moveDown(0.3);
        doc.fontSize(9);
        components.forEach((c) => {
            const scoreLabel = c.available ? `${Math.round(c.score * 100)}%` : 'N/A';
            doc.text(`${c.icon} ${c.label} | Impact ${c.weight}% | Metric score ${scoreLabel}`);
        });

        doc.moveDown(0.9);
        doc.fontSize(14).fillColor('#B00020').text(`Final score: ${final.score100}%`);
        doc.fillColor('#000');
        doc.fontSize(10).text(`Weight coverage used in calculation: ${final.usedWeight}%`);

        doc.end();
    });
}

function getSmtpConfig() {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 0);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM;

    if (!host || !port || !user || !pass || !from) {
        return null;
    }

    return {
        host,
        port,
        secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
        auth: { user, pass },
        from
    };
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

app.post('/api/send-conversation-report', async (req, res) => {
    const { recipient, pdfBase64, mailSubject } = req.body || {};

    if (!pdfBase64 || typeof pdfBase64 !== 'string') {
        return res.status(400).json({ error: 'Missing analysis PDF payload' });
    }

    const smtp = getSmtpConfig();
    if (!smtp) {
        return res.status(503).json({ error: 'SMTP is not configured on server' });
    }

    try {
        const pdfBuffer = Buffer.from(pdfBase64, 'base64');

        if (!pdfBuffer.length) {
            return res.status(400).json({ error: 'Invalid analysis PDF payload' });
        }

        const transporter = nodemailer.createTransport({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            auth: smtp.auth
        });

        await transporter.sendMail({
            from: smtp.from,
            to: recipient || 'spariente777@icloud.com',
            subject: String(mailSubject || 'דוח ניתוח ביצועי שיחה'),
            text: 'מצורף דוח PDF מדף ניתוח ביצועי שיחה כפי שמוצג במערכת.',
            attachments: [
                {
                    filename: `conversation-report-${Date.now()}.pdf`,
                    content: pdfBuffer,
                    contentType: 'application/pdf'
                }
            ]
        });

        return res.json({ ok: true });
    } catch (err) {
        console.error('[Report email error]', err.message);
        return res.status(502).json({ error: 'Failed to send report email' });
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
