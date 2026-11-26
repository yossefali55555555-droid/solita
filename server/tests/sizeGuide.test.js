import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIZE_GUIDE, sizeGuideSchema } from '../src/validators/sizeGuide.js';
import { client, createUser, getTestApp, loginAs } from './helpers.js';

describe('size guide', () => {
  it('has valid defaults', () => {
    expect(sizeGuideSchema.safeParse(DEFAULT_SIZE_GUIDE).success).toBe(true);
  });

  it('serves the defaults publicly, and the saved version after an admin adds a size', async () => {
    const before = await request(getTestApp()).get('/api/public/size-guide');
    expect(before.status).toBe(200);
    expect(before.body.guide).toEqual(DEFAULT_SIZE_GUIDE);

    const admin = await loginAs(await createUser('admin'));
    const next = structuredClone(DEFAULT_SIZE_GUIDE);
    next.sizes.push({ size: 46, visible: true });
    next.models[0].mm['46'] = 285;
    expect((await admin.patch('/api/admin/size-guide', next)).status).toBe(200);

    const after = await request(getTestApp()).get('/api/public/size-guide');
    expect(after.body.guide.models[0].mm['46']).toBe(285);
    expect(after.body.revision).toBe(1);
  });

  it('rejects duplicate sizes, and anonymous writes', async () => {
    const admin = await loginAs(await createUser('admin'));
    const bad = structuredClone(DEFAULT_SIZE_GUIDE);
    bad.sizes.push({ size: 41, visible: true });
    expect((await admin.patch('/api/admin/size-guide', bad)).status).toBeGreaterThanOrEqual(400);
    expect((await client().patch('/api/admin/size-guide', DEFAULT_SIZE_GUIDE)).status).toBeGreaterThanOrEqual(400);
  });
});
