import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostRepository } from '../src/repositories/postRepository.js';
import { createPostsController, mapPostToResponse } from '../src/controllers/postsController.js';

test('mapPostToResponse correctly maps isSaved boolean', () => {
  const post1 = { id: 10, content: 'Hello', is_saved: true };
  const mapped1 = mapPostToResponse(post1);
  assert.equal(mapped1.isSaved, true);

  const post2 = { id: 11, content: 'World', isSaved: false };
  const mapped2 = mapPostToResponse(post2);
  assert.equal(mapped2.isSaved, false);

  const post3 = { id: 12, content: 'Test' };
  const mapped3 = mapPostToResponse(post3);
  assert.equal(mapped3.isSaved, false);
});

test('toggleSavePost throws 401 when user is not authenticated', async () => {
  const repo = createPostRepository({ pool: {} });
  await assert.rejects(
    () => repo.toggleSavePost({ userId: null, postId: '123' }),
    (err) => {
      assert.equal(err.statusCode, 401);
      assert.match(err.message, /đăng nhập/);
      return true;
    }
  );
});

test('toggleSavePost inserts when not present, and deletes when present', async () => {
  const savedDb = new Map();
  const mockPool = {
    async query(sql, params) {
      if (sql.includes('CREATE TABLE')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT id FROM saved_posts')) {
        const [userId, postId] = params;
        const key = `${userId}:${postId}`;
        return savedDb.has(key) ? { rows: [{ id: 1 }] } : { rows: [] };
      }
      if (sql.includes('INSERT INTO saved_posts')) {
        const [userId, postId] = params;
        const key = `${userId}:${postId}`;
        savedDb.set(key, true);
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM saved_posts')) {
        const [userId, postId] = params;
        const key = `${userId}:${postId}`;
        savedDb.delete(key);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const repo = createPostRepository({ pool: mockPool });
  const userId = 'u-test-123';
  const postId = '456';

  // Lần 1: Lưu bài viết
  const saveRes = await repo.toggleSavePost({ userId, postId });
  assert.equal(saveRes.isSaved, true);
  assert.equal(saveRes.postId, '456');

  // Lần 2: Bỏ lưu bài viết
  const unsaveRes = await repo.toggleSavePost({ userId, postId });
  assert.equal(unsaveRes.isSaved, false);
  assert.equal(unsaveRes.postId, '456');
});

test('postsController toggleSavePost and getSavedPosts', async () => {
  let toggled = false;
  const mockRepo = {
    async toggleSavePost({ userId, postId }) {
      toggled = !toggled;
      return { isSaved: toggled, postId };
    },
    async getSavedPosts({ userId }) {
      return [
        {
          id: 101,
          content: 'Saved post',
          author_id: 'a1',
          full_name: 'Author One',
          is_saved: true,
        },
      ];
    },
  };

  const controller = createPostsController({
    postService: {},
    postRepository: mockRepo,
    imageModerationService: {},
  });

  // Test toggle controller
  let resStatus = 0;
  let resJson = null;
  const res = {
    status(code) {
      resStatus = code;
      return this;
    },
    json(data) {
      resJson = data;
      return this;
    },
  };

  await controller.toggleSavePost(
    { params: { postId: '101' }, user: { id: 'u1' } },
    res,
    () => {}
  );
  assert.equal(resStatus, 200);
  assert.equal(resJson.success, true);
  assert.equal(resJson.isSaved, true);

  // Test getSavedPosts controller
  await controller.getSavedPosts(
    { user: { id: 'u1' } },
    res,
    () => {}
  );
  assert.equal(resStatus, 200);
  assert.equal(resJson.success, true);
  assert.equal(resJson.data.length, 1);
  assert.equal(resJson.data[0].id, '101');
  assert.equal(resJson.data[0].isSaved, true);
});

test('togglePinPost pins normal posts and blocks pinning hard-hidden violation posts', async () => {
  const { createPostService } = await import('../src/services/postService.js');
  const postsDb = new Map([
    ['10', { id: 10, author_id: 'u1', content: 'Clean post', ai_status: 'approved', image_moderation_status: 'safe', is_pinned: false }],
    ['11', { id: 11, author_id: 'u1', content: 'Violent post', ai_status: 'hidden', ai_label: 'Violence', image_moderation_status: 'safe', is_pinned: false }],
    ['12', { id: 12, author_id: 'u1', content: 'Rejected image post', ai_status: 'approved', image_moderation_status: 'rejected_admin', is_pinned: false }],
    ['13', { id: 13, author_id: 'u2', content: 'Other user post', ai_status: 'approved', image_moderation_status: 'safe', is_pinned: false }],
  ]);

  const mockRepo = {
    async findByIdForOwnerAction(postId) {
      return postsDb.get(String(postId)) || null;
    },
    async setPostPinned({ postId, authorId, isPinned }) {
      const post = postsDb.get(String(postId));
      if (!post || post.author_id !== authorId) return null;
      if (isPinned && (post.ai_status === 'hidden' || ['pending_review', 'rejected_hold', 'rejected_admin', 'appeal_pending', 'rejected_final'].includes(post.image_moderation_status))) {
        return null;
      }
      post.is_pinned = Boolean(isPinned);
      post.pinned_at = isPinned ? '2026-11-25T12:00:00.000Z' : null;
      return { ...post };
    },
  };

  const postService = createPostService({ postRepository: mockRepo, moderationHook: {} });

  // 1. Tác giả ghim bài viết hợp lệ
  const pinned = await postService.togglePinPost({ user: { id: 'u1' }, postId: '10', isPinned: true });
  assert.equal(pinned.is_pinned, true);
  assert.ok(pinned.pinned_at);
  assert.equal(mapPostToResponse(pinned, 'u1').isPinned, true);

  // 2. Chặn ghim bài viết bị ẩn cứng do vi phạm ngôn từ (Violence / Hate Speech)
  await assert.rejects(
    () => postService.togglePinPost({ user: { id: 'u1' }, postId: '11', isPinned: true }),
    (err) => err.statusCode === 409 && /Không thể ghim bài viết đang bị ẩn/.test(err.message)
  );

  // 3. Chặn ghim bài viết bị ẩn cứng do vi phạm hình ảnh
  await assert.rejects(
    () => postService.togglePinPost({ user: { id: 'u1' }, postId: '12', isPinned: true }),
    (err) => err.statusCode === 409
  );

  // 4. Chặn người khác ghim bài trên trang cá nhân không phải của họ
  await assert.rejects(
    () => postService.togglePinPost({ user: { id: 'u1' }, postId: '13', isPinned: true }),
    (err) => err.statusCode === 403
  );

  // 5. Nếu bài đã ghim sau đó bị ẩn cứng, mapPostToResponse tự động coi isPinned = false
  const laterHidden = { ...pinned, ai_status: 'hidden', is_pinned: true };
  assert.equal(mapPostToResponse(laterHidden, 'u1').isPinned, false);
});

