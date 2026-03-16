import Stripe from 'stripe';
import { db } from '../utils/db';

export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
        case 'checkout.session.completed':
            await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
            break;

        case 'invoice.paid':
            await handleInvoicePaid(event.data.object as Stripe.Invoice);
            break;

        case 'invoice.payment_failed':
            await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
            break;

        case 'customer.subscription.updated':
            await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
            break;

        case 'customer.subscription.deleted':
            await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
            break;

        default:
            console.log(`[Webhook] Unhandled event type: ${event.type}`);
    }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const customerId = session.customer as string;
    const subscriptionId = session.subscription as string;
    const restaurantId = session.metadata?.restaurant_id;

    if (!restaurantId || !subscriptionId) {
        console.error('[Webhook] checkout.session.completed missing restaurant_id or subscription', {
            customerId,
            subscriptionId,
            metadata: session.metadata,
        });
        return;
    }

    console.log(`[Webhook] checkout.session.completed for restaurant ${restaurantId}`);

    await db.query(
        `UPDATE restaurants
         SET stripe_customer_id = $1, subscription_status = 'active', plan = 'pro', updated_at = NOW()
         WHERE id = $2`,
        [customerId, restaurantId]
    );

    await db.query(
        `INSERT INTO subscriptions (restaurant_id, stripe_subscription_id, stripe_customer_id, stripe_price_id, status)
         VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT (stripe_subscription_id) DO UPDATE SET
           status = 'active',
           updated_at = NOW()`,
        [restaurantId, subscriptionId, customerId, session.metadata?.price_id || '']
    );
}

async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const subscriptionId = invoice.subscription as string;
    if (!subscriptionId) return;

    console.log(`[Webhook] invoice.paid for subscription ${subscriptionId}`);

    const periodStart = invoice.lines?.data?.[0]?.period?.start;
    const periodEnd = invoice.lines?.data?.[0]?.period?.end;

    await db.query(
        `UPDATE subscriptions
         SET status = 'active',
             current_period_start = to_timestamp($1),
             current_period_end = to_timestamp($2),
             updated_at = NOW()
         WHERE stripe_subscription_id = $3`,
        [periodStart || null, periodEnd || null, subscriptionId]
    );

    const sub = await db.query(
        `SELECT restaurant_id FROM subscriptions WHERE stripe_subscription_id = $1`,
        [subscriptionId]
    );

    if (sub.rows.length > 0) {
        await db.query(
            `UPDATE restaurants SET subscription_status = 'active', plan = 'pro', updated_at = NOW() WHERE id = $1`,
            [sub.rows[0].restaurant_id]
        );
    }
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const subscriptionId = invoice.subscription as string;
    if (!subscriptionId) return;

    console.log(`[Webhook] invoice.payment_failed for subscription ${subscriptionId}`);

    await db.query(
        `UPDATE subscriptions SET status = 'past_due', updated_at = NOW() WHERE stripe_subscription_id = $1`,
        [subscriptionId]
    );

    const sub = await db.query(
        `SELECT restaurant_id FROM subscriptions WHERE stripe_subscription_id = $1`,
        [subscriptionId]
    );

    if (sub.rows.length > 0) {
        await db.query(
            `UPDATE restaurants SET subscription_status = 'past_due', updated_at = NOW() WHERE id = $1`,
            [sub.rows[0].restaurant_id]
        );
    }
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    const subscriptionId = subscription.id;
    const status = subscription.status;

    console.log(`[Webhook] customer.subscription.updated: ${subscriptionId} -> ${status}`);

    const mappedStatus = mapStripeStatus(status);

    await db.query(
        `UPDATE subscriptions
         SET status = $1,
             cancel_at_period_end = $2,
             canceled_at = $3,
             current_period_start = to_timestamp($4),
             current_period_end = to_timestamp($5),
             updated_at = NOW()
         WHERE stripe_subscription_id = $6`,
        [
            mappedStatus,
            subscription.cancel_at_period_end,
            subscription.canceled_at ? new Date(subscription.canceled_at * 1000).toISOString() : null,
            subscription.current_period_start,
            subscription.current_period_end,
            subscriptionId,
        ]
    );

    const sub = await db.query(
        `SELECT restaurant_id FROM subscriptions WHERE stripe_subscription_id = $1`,
        [subscriptionId]
    );

    if (sub.rows.length > 0) {
        const plan = mappedStatus === 'active' ? 'pro' : (mappedStatus === 'canceled' ? 'trial' : 'pro');
        await db.query(
            `UPDATE restaurants SET subscription_status = $1, plan = $2, updated_at = NOW() WHERE id = $3`,
            [mappedStatus, plan, sub.rows[0].restaurant_id]
        );
    }
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const subscriptionId = subscription.id;

    console.log(`[Webhook] customer.subscription.deleted: ${subscriptionId}`);

    await db.query(
        `UPDATE subscriptions
         SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
         WHERE stripe_subscription_id = $1`,
        [subscriptionId]
    );

    const sub = await db.query(
        `SELECT restaurant_id FROM subscriptions WHERE stripe_subscription_id = $1`,
        [subscriptionId]
    );

    if (sub.rows.length > 0) {
        await db.query(
            `UPDATE restaurants SET subscription_status = 'canceled', plan = 'trial', updated_at = NOW() WHERE id = $1`,
            [sub.rows[0].restaurant_id]
        );
    }
}

function mapStripeStatus(status: string): string {
    switch (status) {
        case 'active':
        case 'trialing':
            return 'active';
        case 'past_due':
            return 'past_due';
        case 'canceled':
        case 'unpaid':
            return 'canceled';
        case 'incomplete':
        case 'incomplete_expired':
            return 'incomplete';
        default:
            return status;
    }
}
