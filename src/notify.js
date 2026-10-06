// Customer notification adapter (SMS/email). The mock records nothing and sends nothing; swap in Twilio/SendGrid/etc.
// Interface: send({ to, template, data }) -> { status }.
export const mockNotifier = { send: () => ({ status: 'queued' }) };
