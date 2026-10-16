import { OWNER_ID } from '../lib/config.js';
import { say } from '../lib/telegram.js';
import { addSecretaryConn, removeSecretaryConn } from '../lib/secretary.js';

// SECRETARY MODE: fires when this bot is connected to / disconnected from an account in
// Telegram Settings > Account > Chat Automation.
//
// The file keeps the name "business_connection" because that is what Telegram's API still
// calls the update (and the name is how Telegram Serverless routes it).
export default async function (conn) {
  if (conn.user?.id !== OWNER_ID) {
    console.warn('Ignoring secretary connection from user', conn.user?.id);
    return;
  }

  const target = conn.user_chat_id ?? OWNER_ID;

  try {
    if (conn.is_enabled === false) {
      await removeSecretaryConn(conn.id);
      await say(target, '🔌 Your main account disconnected me. Secretary mode is off: I no longer answer messages there.');
      return;
    }

    await addSecretaryConn(conn.id);
    const canReply = conn.rights?.can_reply ?? conn.can_reply;
    await say(target, canReply === false
      ? '🔗 Connected to your main account, but I do NOT have permission to reply. Enable "Reply to messages" for me in Settings > Account > Chat Automation.'
      : '🔗 Secretary mode is connected to your main account. I will answer incoming messages as your secretary. Use /secretary off to pause me and /secretaryinfo to tell me what I may share.');
  } catch (e) {
    console.error(e);
  }
}
