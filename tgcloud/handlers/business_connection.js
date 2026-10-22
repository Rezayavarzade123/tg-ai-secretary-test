import { say } from '../lib/telegram.js';
import { addSecretaryConn, removeSecretaryConn } from '../lib/secretary.js';
import { isOwner, ownerId } from '../lib/owner.js';
import { logActivity } from '../lib/activity.js';

// SECRETARY MODE: fires when this bot is connected to / disconnected from an account in
// Telegram Settings > Account > Chat Automation.
//
// The file keeps the name "business_connection" because that is what Telegram's API still
// calls the update (and the name is how Telegram Serverless routes it).
export default async function (conn) {
  if (!(await isOwner(conn.user?.id))) {
    console.warn('Ignoring secretary connection from user', conn.user?.id);
    return;
  }

  const target = conn.user_chat_id ?? (await ownerId());

  try {
    if (conn.is_enabled === false) {
      await removeSecretaryConn(conn.id);
      await logActivity('info', 'Account disconnected — secretary mode is off.');
      await say(target, '🔌 Your main account disconnected me. Secretary mode is off: I no longer answer messages there.');
      return;
    }

    await addSecretaryConn(conn.id);
    const canReply = conn.rights?.can_reply ?? conn.can_reply;
    await logActivity('info', `Connected to the owner's account (connection ${conn.id}).`);

    if (canReply === false) {
      await say(target,
        '🔗 Connected to your main account, but I do NOT have permission to reply.\n' +
        'Enable "Reply to messages" for me in Settings > Account > Chat Automation.');
      return;
    }

    await say(target,
      '🔗 Secretary mode is connected to your main account.\n' +
      'Open the control panel to choose what I do with incoming messages:\n' +
      '• draft — show you the reply first (default)\n' +
      '• auto — answer after the safety checks\n' +
      '• off — never answer\n\n' +
      'Tell me what I may share with /secretaryinfo, and pick the language with /lang.');
  } catch (e) {
    console.error(e);
    await logActivity('error', `Handling the secretary connection failed: ${e?.message ?? e}`);
  }
}
