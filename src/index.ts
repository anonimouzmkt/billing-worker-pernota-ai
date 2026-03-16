import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import Stripe from 'stripe';
import { db } from './utils/db';
import { handleWebhookEvent } from './handlers/webhookHandler';

const app = express();
const PORT = process.env.PORT || 3017;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-02-25.clover',
});

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

app.get('/health', (_req, res) => {
    res.json({ status: 'Billing server running', timestamp: new Date().toISOString() });
});

app.post(
    '/webhook',
    express.raw({ type: 'application/json' }),
    async (req: express.Request, res: express.Response) => {
        const sig = req.headers['stripe-signature'] as string;

        let event: Stripe.Event;

        try {
            event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
        } catch (err: any) {
            console.error(`[Webhook] Signature verification failed: ${err.message}`);
            res.status(400).send(`Webhook Error: ${err.message}`);
            return;
        }

        console.log(`[Webhook] Received event: ${event.type} (${event.id})`);

        try {
            await handleWebhookEvent(event);
            res.json({ received: true });
        } catch (err) {
            console.error(`[Webhook] Error handling event ${event.type}:`, err);
            res.status(500).json({ error: 'Webhook handler failed' });
        }
    }
);

async function main() {
    console.log('[BillingServer] Starting...');

    try {
        const result = await db.query('SELECT NOW()');
        console.log(`[BillingServer] Database connected. Server time: ${result.rows[0].now}`);
    } catch (err) {
        console.error('[BillingServer] FATAL: Cannot connect to database:', err);
        process.exit(1);
    }

    app.listen(PORT, () => {
        console.log(`[BillingServer] Running on port ${PORT}`);
        console.log(`[BillingServer] Webhook endpoint: POST /webhook`);
    });
}

main().catch((err) => {
    console.error('[BillingServer] Fatal error:', err);
    process.exit(1);
});
