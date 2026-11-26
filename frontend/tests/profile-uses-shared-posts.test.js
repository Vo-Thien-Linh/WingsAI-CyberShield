import test from 'node:test';
import assert from 'node:assert/strict';
import { getProfilePosts, groupProfilePostsByMonth, isEffectivelyPinnedProfilePost } from '../src/utils/profilePostLogic.js';
import { canPinPost } from '../src/utils/postActionLogic.js';

test('own profile uses shared feed posts so removals appear without reload', () => {
  const shared = [{ id: '1', author_id: 'author-1' }];
  const localFetched = [{ id: '1', author_id: 'author-1' }, { id: '2', author_id: 'author-1' }];

  assert.deepEqual(getProfilePosts({ isOwnProfile: true, posts: shared, profilePosts: localFetched, targetUserId: 'author-1' }), shared);
  assert.deepEqual(getProfilePosts({ isOwnProfile: false, posts: shared, profilePosts: localFetched, targetUserId: 'author-1' }), localFetched);
});

test('profile posts sort pinned posts to the top but exclude hard-hidden violation posts from being pinned', () => {
  const user = { id: 'author-1' };
  const olderNormal = { id: '1', author: { id: 'author-1' }, isPinned: false };
  const pinnedClean = { id: '2', author: { id: 'author-1' }, isPinned: true, pinnedAt: '2026-11-25T10:00:00.000Z', ai_status: 'approved' };
  const pinnedButHardHidden = { id: '3', author: { id: 'author-1' }, isPinned: true, pinnedAt: '2026-11-25T11:00:00.000Z', ai_status: 'hidden' };
  const rejectedImagePost = { id: '4', author: { id: 'author-1' }, isPinned: true, imageModeration: { status: 'rejected_admin' } };

  assert.equal(canPinPost(pinnedClean, user), true);
  assert.equal(canPinPost(pinnedButHardHidden, user), false);
  assert.equal(canPinPost(rejectedImagePost, user), false);
  assert.equal(isEffectivelyPinnedProfilePost(pinnedClean), true);
  assert.equal(isEffectivelyPinnedProfilePost(pinnedButHardHidden), false);
  assert.equal(isEffectivelyPinnedProfilePost(rejectedImagePost), false);

  const ordered = getProfilePosts({
    isOwnProfile: true,
    posts: [olderNormal, pinnedButHardHidden, pinnedClean],
    targetUserId: 'author-1',
  });
  assert.equal(ordered[0].id, '2');
});

test('groupProfilePostsByMonth groups posts by month and year newest-first', () => {
  const posts = [
    { id: '1', createdAtIso: '2026-06-26T10:00:00.000Z', content: 'Tháng 6' },
    { id: '2', createdAtIso: '2026-11-23T19:59:00.000Z', content: 'Tháng 11 A' },
    { id: '3', createdAtIso: '2026-11-05T08:00:00.000Z', content: 'Tháng 11 B' },
  ];

  const grouped = groupProfilePostsByMonth(posts, false);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].label, 'Tháng 11 năm 2026');
  assert.deepEqual(grouped[0].posts.map((p) => p.id), ['2', '3']);
  assert.equal(grouped[1].label, 'Tháng 6 năm 2026');
  assert.deepEqual(grouped[1].posts.map((p) => p.id), ['1']);
});

