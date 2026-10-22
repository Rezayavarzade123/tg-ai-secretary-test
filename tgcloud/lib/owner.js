import { OWNER_ID } from './config.js';
import { getSetting } from './settings.js';

// Who the bot belongs to.
//
// On the local runner the owner can be set from the control panel (stored as the
// `owner_id` setting), so there is no need to edit config.js and redeploy. The
// config.js value stays as the fallback, so an existing deployment keeps working.
export async function ownerId() {
  const stored = Number(await getSetting('owner_id', '0'));
  if (Number.isInteger(stored) && stored > 0) return stored;
  return OWNER_ID;
}

export async function isOwner(userId) {
  const id = await ownerId();
  return id !== 0 && Number(userId) === id;
}

export async function ownerName() {
  return getSetting('owner_name', 'the owner');
}
