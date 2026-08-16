'use strict';

const axios = require('axios');
const client = require('../gpt-api-client');

describe('gpt api client', () => {
    afterEach(() => vi.restoreAllMocks());

    it('inspects the session before checkout using only documented fields', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { ok: true, verified: true, current_plan: 'Free' }
        });
        const out = await client.inspectPay(
            { base_url: 'https://example.test/api/v1', api_key: 'gptk_test' },
            { planKey: 'plus', session: { accessToken: 'token', user: { email: 'user@example.com' } } }
        );
        expect(out.success).toBe(true);
        expect(spy.mock.calls[0][0].url).toBe('https://example.test/api/v1/pay/inspect');
        expect(spy.mock.calls[0][0].data).toEqual({
            plan_key: 'plus',
            session: { accessToken: 'token', user: { email: 'user@example.com' } }
        });
    });

    it('preserves structured unverified reasons', async () => {
        vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: {
                ok: false,
                verified: false,
                error: 'session_unverified',
                reason: 'cloudflare_challenge',
                upstream_status: 403
            }
        });
        const out = await client.inspectPay(
            { base_url: 'https://example.test/api/v1', api_key: 'gptk_test' },
            { planKey: 'plus', sessionToken: 'token' }
        );
        expect(out).toMatchObject({
            success: false,
            error: 'session_unverified',
            reason: 'cloudflare_challenge',
            upstreamStatus: 403
        });
    });

    it('sends the protocol proxy field to pay', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { order_id: 1, task_id: 2 }
        });
        await client.submitPay(
            { base_url: 'https://example.test/api/v1', api_key: 'gptk_test' },
            {
                planKey: 'plus',
                session: { accessToken: 'token', user: { email: 'user@example.com' } },
                newCard: { number: '4242', exp_month: 12, exp_year: 2030, cvc: '123' },
                proxy: 'http://ignored.example:8080',
                idempotencyKey: 'pay-1'
            }
        );
        expect(spy.mock.calls[0][0].data.proxy).toBe('http://ignored.example:8080');
        expect(spy.mock.calls[0][0].data.session.user.email).toBe('user@example.com');
    });
    it('parses the platform gpt plans array', async () => {
        vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { gpt: [{ key: 'plus' }], credit: [] } });
        const out = await client.fetchPlans({ base_url: 'https://example.test/api/v1', api_key: 'gptk_test' });
        expect(out.plans).toEqual([{ key: 'plus' }]);
    });

    it('uses the business result status instead of queue done', () => {
        expect(client.extractStatus({ status: 'done', result: { ok: false, status: 'failed', error: 'cf_challenge_unresolved' } })).toBe('failed');
        expect(client.extractStatus({ status: 'done', result: { ok: true, status: 'success' } })).toBe('success');
    });

    it('sends documented client reference and saved-card fields', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { ok: true, already_submitted: true, order_id: 12, task_id: 34, topup_code: 'code-prefix...' }
        });
        const out = await client.submitPay(
            { base_url: 'https://example.test/api/v1', api_key: 'gptk_test' },
            { planKey: 'plus', sessionToken: 'token', cardId: 8, cvc: '123', acceptWarnings: true, country: 'US', currency: 'USD', clientRef: 'kc-cdk-1', idempotencyKey: 'pay-1' }
        );
        expect(spy.mock.calls[0][0].data).toMatchObject({
            plan_key: 'plus', card_id: 8, cvc: '123', accept_warnings: true,
            country: 'US', currency: 'USD', client_ref: 'kc-cdk-1', session: { access_token: 'token' }
        });
        expect(out).toMatchObject({ orderId: 12, taskId: 34, alreadySubmitted: true, topupCode: 'code-prefix...' });
    });

    it('separates GPT and credit plans and summarizes balance', async () => {
        vi.spyOn(axios, 'request')
            .mockResolvedValueOnce({ status: 200, data: { gpt: [{ key: 'plus' }], credit: [{ id: 2, credits: 100 }] } })
            .mockResolvedValueOnce({ status: 200, data: { credits: 980, balance: 1250, balance_usd: '12.50' } });
        const plans = await client.fetchPlans({ base_url: 'https://example.test/api/v1', api_key: 'gptk_test' });
        const balance = await client.queryBalance({ base_url: 'https://example.test/api/v1', api_key: 'gptk_test' });
        expect(plans).toMatchObject({ gptPlans: [{ key: 'plus' }], creditPlans: [{ id: 2, credits: 100 }] });
        expect(balance).toMatchObject({ credits: 980, balance: 1250, balanceUsd: '12.50' });
    });

});
