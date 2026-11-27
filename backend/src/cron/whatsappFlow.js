/* WhatsApp order confirmation — the per-minute worker (production only, like
   every cron). Sends due confirmations and reminders, releases held orders to
   the agents when their 30 minutes end, and rescues anything stuck.
   All the logic is in services/whatsapp/engine.js; this only keeps time. */
'use strict';

const cron   = require('node-cron');
const engine = require('../services/whatsapp/engine');

function startWhatsappFlowCron() {
  /* tables at boot, not during the first order */
  require('../services/whatsapp/flowStore').ensureSchema()
    .then(() => console.log('✅  WhatsApp flow: schema ready'))
    .catch((e) => console.warn('⚠️   WhatsApp flow schema:', e.message));
  cron.schedule('* * * * *', async () => {
    try {
      const r = await engine.tick();
      if (r && !r.skipped && (r.sent || r.released || r.reminders || r.rescued)) {
        console.log(`[whatsapp flow] tick: sent ${r.sent}, released ${r.released}, reminders ${r.reminders}, rescued ${r.rescued}`);
      }
    } catch (e) {
      console.warn('[whatsapp flow] tick failed:', e.message);
    }
  }, { timezone: 'Africa/Cairo' });
  /* Meta's view of the number (quality + daily limit tier), twice an hour while the flow is on */
  cron.schedule('7,37 * * * *', () => { engine.refreshHealth().catch(() => {}); }, { timezone: 'Africa/Cairo' });
  setTimeout(() => { engine.refreshHealth().catch(() => {}); }, 30000);
  console.log('✅  WhatsApp flow: worker started (every minute)');
}

module.exports = { startWhatsappFlowCron };
