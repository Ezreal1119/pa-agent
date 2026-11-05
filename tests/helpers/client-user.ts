import { UserStore } from '../../src/ckd/users.js';

export const clientCredentials = { account: 'client-test', password: 'client-test-long-password' };
export async function readyClientUser(dataDir: string) {
  const users = new UserStore(dataDir), { user, initialPassword } = await users.create(clientCredentials.account);
  await users.changePassword(user.id, 1, initialPassword, clientCredentials.password);
  return user;
}
