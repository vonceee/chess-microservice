const axios = require('axios');
const config = require('../config');

/**
 * Notify Laravel of a user disconnection to cleanup matchmaking seeks.
 */
async function notifyUserDisconnected(userId) {
  try {
    const payload = { user_id: userId };
    const response = await axios.post(`${config.API_BASE_URL}/api/internal/matchmaking/cleanup`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': config.INTERNAL_SECRET
      },
      timeout: 5000
    });

    if (response.data.success) {
      console.log(`[Microservice] Disconnect cleanup for user ${userId} reported to Laravel.`);
    }
  } catch (error) {
    const errorMsg = error.response ? 
      `Server responded with ${error.response.status}` : 
      error.message;
    console.error(`[Microservice] Failed to notify Laravel of disconnect for user ${userId}: ${errorMsg}`);
  }
}

module.exports = { notifyUserDisconnected };
