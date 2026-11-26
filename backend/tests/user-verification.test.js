import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserRepository } from '../src/repositories/userRepository.js';

test('updateVerification: updates is_verified status for target user', async () => {
  let executedQuery = '';
  let queryParams = [];

  const mockPool = {
    async query(sql, params) {
      executedQuery = sql;
      queryParams = params;
      return {
        rows: [{
          id: params[1],
          username: 'wings_user',
          full_name: 'Wings User',
          is_verified: params[0],
        }],
      };
    },
  };

  const userRepo = createUserRepository({ pool: mockPool });
  userRepo.findById = async (id) => ({ id, username: 'wings_user', is_verified: false });

  const result = await userRepo.updateVerification({
    targetUserId: 'user-123',
    isVerified: true,
  });

  assert.equal(result.is_verified, true);
  assert.equal(queryParams[0], true);
  assert.equal(queryParams[1], 'user-123');
  assert.match(executedQuery, /UPDATE users/i);
  assert.match(executedQuery, /is_verified = \$1/i);
});

test('updateVerification: throws 404 when user not found', async () => {
  const mockPool = {
    async query() {
      return { rows: [] };
    },
  };

  const userRepo = createUserRepository({ pool: mockPool });
  userRepo.findById = async () => null;

  await assert.rejects(
    async () => {
      await userRepo.updateVerification({
        targetUserId: 'missing-user',
        isVerified: true,
      });
    },
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.match(err.message, /Không tìm thấy người dùng/i);
      return true;
    }
  );
});

test('updateTrustScore: adjusts score, records trust log, and notifies user', async () => {
  const queries = [];
  const mockPool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('UPDATE users')) {
        return {
          rows: [{
            id: params[1],
            username: 'wings_user',
            full_name: 'Wings User',
            email: 'wings@example.com',
            role: 'user',
            status: 'active',
            is_verified: false,
            trust_score: params[0],
          }],
        };
      }
      return { rows: [] };
    },
  };

  const userRepo = createUserRepository({ pool: mockPool });
  userRepo.findById = async (id) => ({ id, username: 'wings_user', trust_score: 70 });

  const result = await userRepo.updateTrustScore({
    targetUserId: 'user-123',
    trustScore: 95,
    reason: 'Đóng góp tích cực cho cộng đồng',
    actorId: 'admin-1',
  });

  assert.equal(result.trust_score, 95);
  assert.equal(result.old_score, 70);
  assert.equal(result.change_amount, 25);
  assert.ok(queries.some((q) => q.sql.includes('INSERT INTO user_trust_logs') && q.params[1] === 25 && q.params[2] === 95));
  assert.ok(queries.some((q) => q.sql.includes('INSERT INTO notifications') && q.params[0] === 'user-123'));
});

