import { isHardHiddenViolationPost } from './postActionLogic.js';

export function isEffectivelyPinnedProfilePost(post) {
  if (!post) return false;
  const rawPinned = Boolean(post.isPinned || post.is_pinned);
  if (!rawPinned) return false;
  return !isHardHiddenViolationPost(post);
}

export function sortProfilePostsWithPinnedFirst(posts = []) {
  return [...posts].sort((left, right) => {
    const leftPinned = isEffectivelyPinnedProfilePost(left);
    const rightPinned = isEffectivelyPinnedProfilePost(right);
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    if (leftPinned && rightPinned) {
      const leftPinTime = Date.parse(left.pinnedAt || left.pinned_at || 0) || 0;
      const rightPinTime = Date.parse(right.pinnedAt || right.pinned_at || 0) || 0;
      if (rightPinTime !== leftPinTime) return rightPinTime - leftPinTime;
    }
    return 0;
  });
}

export function getProfilePosts({ isOwnProfile, posts = [], profilePosts = null, targetUserId }) {
  const source = isOwnProfile || profilePosts === null ? posts : profilePosts;
  const filtered = (source || []).filter((post) =>
    String(post.author?.id ?? post.author_id) === String(targetUserId)
  );
  return sortProfilePostsWithPinnedFirst(filtered);
}

export function resolvePostDate(post) {
  const raw = post?.createdAtIso || post?.created_at || post?.createdAt;
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export function formatGridPostDate(post, isEn = false) {
  const date = resolvePostDate(post);
  if (isEn) {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day} tháng ${month} lúc ${hours}:${minutes}`;
}

export function groupProfilePostsByMonth(posts = [], isEn = false) {
  const groupsMap = new Map();

  for (const post of posts) {
    const date = resolvePostDate(post);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const key = `${year}-${String(month).padStart(2, '0')}`;

    if (!groupsMap.has(key)) {
      const label = isEn
        ? new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(date)
        : `Tháng ${month} năm ${year}`;
      groupsMap.set(key, { key, year, month, label, posts: [] });
    }
    groupsMap.get(key).posts.push(post);
  }

  return [...groupsMap.values()]
    .sort((a, b) => (b.year !== a.year ? b.year - a.year : b.month - a.month))
    .map((group) => ({
      ...group,
      posts: sortProfilePostsWithPinnedFirst(
        [...group.posts].sort((a, b) => resolvePostDate(b).getTime() - resolvePostDate(a).getTime())
      ),
    }));
}
