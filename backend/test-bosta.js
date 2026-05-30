/**
 * test-bosta.js — one-shot Bosta ranking endpoint test
 * Run from the backend folder: node test-bosta.js
 */
require('dotenv').config();
const axios = require('axios');

const PHONE = '+201098013662';
const TOKEN = process.env.BOSTA_BEARER_TOKEN;

async function run() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍  Bosta ranking test');
  console.log('    phone :', PHONE);
  console.log('    token :', TOKEN ? TOKEN.slice(0, 40) + '…' : '❌ NOT SET');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!TOKEN) {
    console.error('BOSTA_BEARER_TOKEN is missing from .env — aborting.');
    process.exit(1);
  }

  try {
    const res = await axios.get(
      'https://app.bosta.co/api/v2/consignee/ranking',
      {
        params: { phone: PHONE },
        headers: {
          Authorization:          TOKEN,
          Origin:                 'https://business.bosta.co',
          Referer:                'https://business.bosta.co/',
          'x-device-fingerprint': 'ko54zl',
          'x-device-id':          '01KNF2HWY0F6XTPBF0YXGS0PVQ',
          'User-Agent':           'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1 Edg/148.0.0.0',
          Accept:                 'application/json, text/plain, */*',
        },
        timeout: 10_000,
      }
    );

    console.log('✅  SUCCESS — HTTP', res.status);
    console.log('📦  Full response data:');
    console.log(JSON.stringify(res.data, null, 2));

  } catch (err) {
    console.error('❌  FAILED');
    console.error('    Status Code  :', err.response?.status ?? 'no response');
    console.error('    Status Text  :', err.response?.statusText ?? err.message);
    console.error('    Response Body:', JSON.stringify(err.response?.data ?? err.message, null, 2));
    console.error('    Request URL  :', err.config?.url);
    console.error('    Request Params:', JSON.stringify(err.config?.params));
  }
}

run();
