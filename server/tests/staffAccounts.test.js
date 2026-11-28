import { describe, expect, it } from 'vitest';
import { AccountInvite, PermissionTemplate, SecurityAlert, Session, StaffActivity, User } from '../src/models/index.js';
import { sha256 } from '../src/utils/sanitize.js';
import { client, createUser, loginAs, PASSWORD } from './helpers.js';

const HOUR = 60 * 60 * 1000;
const customerService = { sections: { orders: 'edit', customers: 'view' }, dangerous: [], fields: [{ key: 'customerPhone', until: null }] };

async function adminApi() {
  const admin = await createUser('admin');
  return { admin, api: await loginAs(admin) };
}

describe('phase 4: creating staff accounts', () => {
  it('creates a moderator with a temporary password shown once, change forced at first sign-in', async () => {
    const { api } = await adminApi();
    const res = await api.post('/api/admin/staff', { name: 'سارة أحمد', phone: '01012345678', mode: 'password', templateName: 'خدمة العملاء' });
    expect(res.status).toBe(201);
    const { tempPassword, account } = res.body;
    expect(tempPassword).toMatch(/[A-Za-z]/);
    expect(tempPassword).toMatch(/\d/);
    expect(account.status).toBe('active');
    expect(account.mustChangePassword).toBe(true);
    expect(account.permissions.sections.orders).toBe('edit'); // copied from the template
    expect(JSON.stringify(res.body.account)).not.toContain('passwordHash');

    // The password is shown once: neither the list nor the detail returns it.
    expect(JSON.stringify((await api.get('/api/admin/staff')).body)).not.toContain(tempPassword);

    const moderator = await loginAs({ phone: '01012345678' }, tempPassword);
    const blocked = await moderator.get('/api/admin/orders');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await moderator.post('/api/auth/change-password', { currentPassword: tempPassword, newPassword: 'Another12345pass' })).status).toBe(200);
    expect((await moderator.get('/api/admin/orders')).status).toBe(200);

    const line = await StaffActivity.findOne({ action: 'account.created' }).lean();
    expect(line.severity).toBe('security');
    expect(line.sentence).toContain('سارة أحمد');
    expect(JSON.stringify(line)).not.toContain(tempPassword);
    expect(JSON.stringify(line)).not.toContain('01012345678');
  });

  it('refuses an admin role, a second admin, duplicate phones, and non-admin callers', async () => {
    const { api } = await adminApi();
    expect((await api.post('/api/admin/staff', { name: 'أدمن ثاني', phone: '01011111111', role: 'admin' })).status).toBe(400);
    expect((await api.post('/api/admin/staff', { name: 'أ ب', phone: '01011111111' })).status).toBe(201);
    expect((await api.post('/api/admin/staff', { name: 'ج د', phone: '01011111111' })).status).toBe(409);

    const moderator = await createUser('moderator', { permissions: { sections: { orders: 'edit' }, dangerous: [], fields: [] } });
    const mod = await loginAs(moderator);
    for (const [method, url] of [['get', '/api/admin/staff'], ['get', '/api/admin/templates'], ['get', '/api/admin/activity'], ['get', '/api/admin/staff/catalog']]) {
      expect((await mod[method](url)).status, url).toBe(403);
    }
    expect((await mod.post('/api/admin/staff', { name: 'ه و', phone: '01022222222' })).status).toBe(403);
    expect((await mod.patch('/api/admin/wa-templates', { cartWhatsappTemplate: 'x', couponWhatsappTemplate: 'y', confirmWhatsappTemplate: 'z' })).status).toBe(403);
  });

  it('never edits the administrator or a courier through the staff routes', async () => {
    const { admin, api } = await adminApi();
    const courier = await createUser('courier');
    expect((await api.patch(`/api/admin/staff/${admin._id}`, { name: 'x y' })).status).toBe(403);
    expect((await api.post(`/api/admin/staff/${admin._id}/status`, { status: 'disabled' })).status).toBe(403);
    expect((await api.patch(`/api/admin/staff/${courier._id}`, { name: 'x y' })).status).toBe(404);
    expect((await User.findById(admin._id)).status).not.toBe('disabled');
  });

  it('a dangerous grant needs "edit" on its section, and temporary grants only where allowed', async () => {
    const { api } = await adminApi();
    const bad = await api.post('/api/admin/staff', { name: 'س ص', phone: '01033333333', permissions: { sections: { orders: 'view' }, dangerous: ['clearOrders'] } });
    expect(bad.status).toBe(400);
    const badExport = await api.post('/api/admin/staff', {
      name: 'س ص',
      phone: '01033333333',
      permissions: { sections: {}, fields: [{ key: 'export', until: new Date(Date.now() + HOUR).toISOString() }] },
    });
    expect(badExport.status).toBe(400);
    const ok = await api.post('/api/admin/staff', { name: 'س ص', phone: '01033333333', permissions: { sections: { orders: 'edit' }, dangerous: ['clearOrders'] } });
    expect(ok.status).toBe(201);
    expect(ok.body.account.templateName).toBe('مخصص');
  });

  it('editing permissions changes them at once and writes a line with what changed', async () => {
    const { api } = await adminApi();
    const created = await api.post('/api/admin/staff', { name: 'منى علي', phone: '01044444444', templateName: 'مشاهدة فقط' });
    const id = created.body.account.id;
    await User.updateOne({ _id: id }, { $set: { mustChangePassword: false } });
    const mod = await loginAs({ phone: '01044444444' }, created.body.tempPassword);
    expect((await mod.get('/api/admin/cash/overview')).status).toBe(403);
    const edit = await api.patch(`/api/admin/staff/${id}`, { permissions: { sections: { orders: 'view', cash: 'view' } } });
    expect(edit.status).toBe(200);
    expect((await mod.get('/api/admin/cash/overview')).status).toBe(200); // next request, no re-login
    const line = await StaffActivity.findOne({ action: 'account.permissions_changed' }).lean();
    expect(line.sentence).toContain('الخزنة: من «بدون» إلى «مشاهدة»');
    expect(line.sentence).toContain('منى علي');
  });
});

describe('phase 4: templates', () => {
  it('lists the five starting templates, an account copies one, editing a template does not touch accounts until applied', async () => {
    const { api } = await adminApi();
    const list = (await api.get('/api/admin/templates')).body.items;
    expect(list.map((t) => t.name)).toEqual(expect.arrayContaining(['خدمة العملاء', 'مرتجعات ومخزن', 'متابعة المناديب', 'محاسب', 'مشاهدة فقط']));
    const tpl = list.find((t) => t.name === 'خدمة العملاء');
    const a = await api.post('/api/admin/staff', { name: 'أحمد ع', phone: '01055555551', templateName: 'خدمة العملاء' });
    await api.post('/api/admin/staff', { name: 'بسمة ع', phone: '01055555552', templateName: 'خدمة العملاء' });

    // Edit the template: coupons becomes "view", cash is added.
    const body = { name: 'خدمة العملاء', sections: { ...tpl.sections, coupons: 'view', cash: 'view' }, dangerous: tpl.dangerous, fields: tpl.fields };
    const updated = await api.patch(`/api/admin/templates/${tpl.id}`, body);
    expect(updated.status).toBe(200);
    expect(updated.body.affected).toBe(2);
    // Accounts still hold the copy they got at creation.
    const stored = await User.findById(a.body.account.id).lean();
    expect(stored.permissions.sections.coupons).toBe('edit');
    expect(stored.permissions.sections.cash).toBeUndefined();

    const preview = (await api.get(`/api/admin/templates/${tpl.id}/apply-preview`)).body;
    expect(preview.accounts).toHaveLength(2);
    expect(preview.changedCount).toBe(2);
    expect(preview.accounts[0].changes.join(' ')).toContain('الخزنة: من «بدون» إلى «مشاهدة»');
    expect(preview.accounts[0].before.sections.coupons).toBe('edit');
    expect(preview.accounts[0].after.sections.coupons).toBe('view');

    const applied = await api.post(`/api/admin/templates/${tpl.id}/apply`, {});
    expect(applied.body.applied).toBe(2);
    expect((await User.findById(a.body.account.id).lean()).permissions.sections.cash).toBe('view');
    const line = await StaffActivity.findOne({ action: 'account.template_applied' }).lean();
    expect(line.sentence).toContain('تطبيق قالب «خدمة العملاء» على 2 حساب');
    expect((await api.get(`/api/admin/templates/${tpl.id}/apply-preview`)).body.changedCount).toBe(0);
  });

  it('a template in use cannot be deleted, and duplicate names are refused', async () => {
    const { api } = await adminApi();
    const list = (await api.get('/api/admin/templates')).body.items;
    await api.post('/api/admin/staff', { name: 'ن ن', phone: '01066666661', templateName: 'محاسب' });
    const accountant = list.find((t) => t.name === 'محاسب');
    expect((await api.post(`/api/admin/templates/${accountant.id}/delete`, {})).status).toBe(409);
    expect((await api.post('/api/admin/templates', { name: 'محاسب', sections: {} })).status).toBe(409);
    const created = await api.post('/api/admin/templates', { name: 'قالب جديد', sections: { orders: 'view' } });
    expect(created.status).toBe(201);
    expect((await api.post(`/api/admin/templates/${created.body.template.id}/delete`, {})).status).toBe(200);
    expect(await PermissionTemplate.countDocuments({ name: 'قالب جديد' })).toBe(0);
  });
});

describe('phase 4: invite links', () => {
  async function invited(api, phone = '01077777771') {
    const res = await api.post('/api/admin/staff', { name: 'مدعو م', phone, mode: 'invite', permissions: customerService });
    expect(res.status).toBe(201);
    return res.body;
  }
  const token = (invite) => invite.token;

  it('stores only a hash, status "invited", expires in 48 hours, and cannot sign in before accepting', async () => {
    const { api } = await adminApi();
    const { account, invite } = await invited(api);
    expect(account.status).toBe('invited');
    expect(token(invite)).toHaveLength(43); // 256 bits, base64url
    const row = await AccountInvite.findOne({ user: account.id }).lean();
    expect(row.tokenHash).toBe(sha256(token(invite)));
    expect(JSON.stringify(row)).not.toContain(token(invite));
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(47 * HOUR);
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(48 * HOUR + 60_000);
    expect(invite.link).toContain('#t=');
    const c = await client();
    expect((await c.post('/api/auth/login', { identifier: '01077777771', password: 'Whatever12345' })).status).toBe(401);
  });

  it('accepting sets the password, activates the account, signs in, and works only once', async () => {
    const { api } = await adminApi();
    const { account, invite } = await invited(api);
    const c = await client();
    const accept = await c.post('/api/auth/invite/accept', { token: token(invite), password: 'MyOwnPass12345' });
    expect(accept.status).toBe(200);
    expect(accept.body.user.role).toBe('moderator');
    expect(accept.body.user.permissions.sections.orders).toBe('edit');
    c.setToken(accept.body.csrfToken);
    expect((await c.get('/api/admin/orders')).status).toBe(200); // signed in, no forced password change
    const stored = await User.findById(account.id).lean();
    expect(stored.status).toBe('active');
    expect(stored.isActive).toBe(true);
    expect(stored.invitePending).toBe(false);
    expect(await AccountInvite.countDocuments({ user: account.id })).toBe(0);
    const again = await (await client()).post('/api/auth/invite/accept', { token: token(invite), password: 'Another12345pass' });
    expect(again.status).toBe(401);
    expect((await (await client()).post('/api/auth/login', { identifier: '01077777771', password: 'MyOwnPass12345' })).status).toBe(200);
  });

  it('an expired link, a wrong token, and a disabled account all fail the same way', async () => {
    const { api } = await adminApi();
    const { account, invite } = await invited(api);
    const c = await client();
    expect((await c.post('/api/auth/invite/accept', { token: 'x'.repeat(43), password: 'MyOwnPass12345' })).status).toBe(401);
    await AccountInvite.updateOne({ user: account.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await c.post('/api/auth/invite/accept', { token: token(invite), password: 'MyOwnPass12345' })).status).toBe(401);

    const second = await invited(api, '01077777772');
    expect((await api.post(`/api/admin/staff/${second.account.id}/status`, { status: 'disabled' })).status).toBe(200);
    expect(await AccountInvite.countDocuments({ user: second.account.id })).toBe(0); // disabling cancels the link
    expect((await c.post('/api/auth/invite/accept', { token: token(second.invite), password: 'MyOwnPass12345' })).status).toBe(401);
    // Enabling a never-accepted account sends it back to "invited", not "active".
    const enabled = await api.post(`/api/admin/staff/${second.account.id}/status`, { status: 'active' });
    expect(enabled.body.account.status).toBe('invited');
  });

  it('a new link cancels the old one and does not apply to active accounts', async () => {
    const { api } = await adminApi();
    const { account, invite } = await invited(api);
    const fresh = await api.post(`/api/admin/staff/${account.id}/invite`, {});
    expect(fresh.status).toBe(200);
    expect(fresh.body.invite.token).not.toBe(token(invite));
    expect(await AccountInvite.countDocuments({ user: account.id })).toBe(1);
    const c = await client();
    expect((await c.post('/api/auth/invite/accept', { token: token(invite), password: 'MyOwnPass12345' })).status).toBe(401);
    expect((await c.post('/api/auth/invite/accept', { token: fresh.body.invite.token, password: 'MyOwnPass12345' })).status).toBe(200);
    expect((await api.post(`/api/admin/staff/${account.id}/invite`, {})).status).toBe(409); // now active
    const { admin } = { admin: await User.findOne({ role: 'admin' }) };
    expect((await api.post(`/api/admin/staff/${admin._id}/invite`, {})).status).toBe(403); // the admin never gets an invite
  });
});

describe('phase 4: controlling an account', () => {
  async function moderatorWithApi(permissions = customerService) {
    const moderator = await createUser('moderator', { permissions });
    return { moderator, mod: await loginAs(moderator) };
  }

  it('disable ends every session; enable brings the account back', async () => {
    const { api } = await adminApi();
    const { moderator, mod } = await moderatorWithApi();
    await loginAs(moderator);
    expect(await Session.countDocuments({ user: moderator._id })).toBe(2);
    expect((await api.post(`/api/admin/staff/${moderator._id}/status`, { status: 'disabled' })).status).toBe(200);
    expect(await Session.countDocuments({ user: moderator._id })).toBe(0);
    expect((await mod.get('/api/auth/me')).status).toBe(401);
    expect((await api.post(`/api/admin/staff/${moderator._id}/status`, { status: 'active' })).body.account.status).toBe('active');
    expect((await loginAs(moderator).then((a) => a.get('/api/admin/orders'))).status).toBe(200);
  });

  it('lists active sessions with a readable device and revokes one or all', async () => {
    const { api } = await adminApi();
    const { moderator } = await moderatorWithApi();
    await Session.updateMany({ user: moderator._id }, { $set: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36' } });
    await loginAs(moderator);
    const detail = (await api.get(`/api/admin/staff/${moderator._id}`)).body.account;
    expect(detail.sessions).toHaveLength(2);
    expect(detail.sessions.some((s) => s.device === 'Chrome على Windows')).toBe(true);
    const one = await api.post(`/api/admin/staff/${moderator._id}/sessions/${detail.sessions[0].id}/revoke`, {});
    expect(one.body.revoked).toBe(1);
    expect((await api.post(`/api/admin/staff/${moderator._id}/sessions/revoke`, {})).body.revoked).toBe(1);
    expect(await Session.countDocuments({ user: moderator._id })).toBe(0);
  });

  it('password reset: new temporary password once, sessions ended, change forced, alert raised, line without the password', async () => {
    const { api } = await adminApi();
    const { moderator, mod } = await moderatorWithApi();
    const res = await api.post(`/api/admin/staff/${moderator._id}/password`, {});
    expect(res.status).toBe(200);
    const { tempPassword } = res.body;
    expect((await mod.get('/api/auth/me')).status).toBe(401);
    const c = await client();
    expect((await c.post('/api/auth/login', { identifier: moderator.phone, password: PASSWORD })).status).toBe(401);
    const login = await c.post('/api/auth/login', { identifier: moderator.phone, password: tempPassword });
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);
    const alert = await SecurityAlert.findOne({ type: 'staff_password_reset' }).lean();
    expect(alert.message).toContain(moderator.name);
    const line = await StaffActivity.findOne({ action: 'auth.staff_password_reset' }).lean();
    expect(line.severity).toBe('security');
    expect(JSON.stringify(line)).not.toContain(tempPassword);
  });

  it('temporary phone grant: sees the number for the period, loses it when withdrawn or expired', async () => {
    const { api } = await adminApi();
    const { moderator, mod } = await moderatorWithApi({ sections: { orders: 'edit', warehouse: 'view' }, dangerous: [], fields: [] });
    expect((await mod.get('/api/auth/me')).body.user.permissions.fields).toEqual([]);
    const grant = await api.post(`/api/admin/staff/${moderator._id}/fields/customerPhone/grant`, { duration: 'hour' });
    expect(grant.status).toBe(200);
    const until = new Date(grant.body.account.phoneGrant.until).getTime();
    expect(until - Date.now()).toBeGreaterThan(HOUR - 60_000);
    expect((await mod.get('/api/auth/me')).body.user.permissions.fields[0].key).toBe('customerPhone');
    expect((await mod.get('/api/admin/labels/view?ids=64b7f0c2a1b2c3d4e5f60718')).status).not.toBe(403);

    const revoke = await api.post(`/api/admin/staff/${moderator._id}/fields/customerPhone/revoke`, {});
    expect(revoke.body.account.phoneGrant).toBeNull();
    expect((await mod.get('/api/admin/labels/view?ids=64b7f0c2a1b2c3d4e5f60718')).status).toBe(403);

    // A grant whose time has passed is ignored by the server on the next request, with no cron.
    await User.updateOne({ _id: moderator._id }, { $set: { 'permissions.fields': [{ key: 'customerPhone', until: new Date(Date.now() - 1000) }] } });
    expect((await mod.get('/api/admin/labels/view?ids=64b7f0c2a1b2c3d4e5f60718')).status).toBe(403);
    expect((await mod.get('/api/auth/me')).body.user.permissions.fields).toEqual([]);

    expect((await api.post(`/api/admin/staff/${moderator._id}/fields/export/grant`, { duration: 'hour' })).status).toBe(400); // export is never temporary
    const custom = await api.post(`/api/admin/staff/${moderator._id}/fields/customerPhone/grant`, { duration: 'custom', until: new Date(Date.now() + 3 * HOUR).toISOString() });
    expect(custom.status).toBe(200);
    expect((await api.post(`/api/admin/staff/${moderator._id}/fields/customerPhone/grant`, { duration: 'custom', until: new Date(Date.now() - HOUR).toISOString() })).status).toBe(400);
    const lines = await StaffActivity.find({ action: { $in: ['account.field_granted', 'account.field_revoked'] } }).lean();
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });
});

describe('phase 4: ready-made WhatsApp texts', () => {
  it('the admin edits them, a moderator with the phone permission reads them but cannot write', async () => {
    const { api } = await adminApi();
    const moderator = await createUser('moderator', { permissions: { sections: { orders: 'view' }, dangerous: [], fields: [{ key: 'customerPhone', until: null }] } });
    const mod = await loginAs(moderator);
    const texts = { cartWhatsappTemplate: 'سلة {name}', couponWhatsappTemplate: 'كوبون {code}', confirmWhatsappTemplate: 'تأكيد {num}' };
    expect((await mod.patch('/api/admin/wa-templates', texts)).status).toBe(403);
    expect((await api.patch('/api/admin/wa-templates', texts)).status).toBe(200);
    const read = await mod.get('/api/admin/wa-templates');
    expect(read.body.templates).toEqual(texts);
    const noPhone = await loginAs(await createUser('moderator', { permissions: { sections: { orders: 'view' }, dangerous: [], fields: [] } }));
    expect((await noPhone.get('/api/admin/wa-templates')).status).toBe(403);
    expect((await StaffActivity.findOne({ action: 'settings.whatsapp_texts' }).lean()).severity).toBe('danger');
  });
});
