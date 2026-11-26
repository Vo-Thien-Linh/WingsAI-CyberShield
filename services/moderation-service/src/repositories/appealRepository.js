import { refundTrustPoints } from '../../../../backend/src/services/trustScoreService.js';
import { appealsStore, aiOverrideLogsStore } from '../../../../backend/src/repositories/memoryStore.js';

export function createAppealRepository({ pool }) {
  return {
    /**
     * Lấy danh sách toàn bộ khiếu nại
     */
    async findAllAppeals() {
      if (pool) {
        try {
          const q = `
            SELECT * FROM moderation_appeal_read_model
            ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC
          `;
          const result = await pool.query(q);
          const coreAppeals = result.rows.map(row => ({
            id: String(row.id),
            user: {
              id: row.user_id,
              name: row.user_name || 'Người dùng',
              avatar: row.user_avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400',
              username: row.username || 'user'
            },
            contentType: row.content_type,
            contentId: String(row.content_id),
            targetPostId: row.target_post_id ? String(row.target_post_id) : null,
            targetPostContent: row.target_post_content || '',
            targetPostImage: row.target_post_ai_status === 'hidden' || ['rejected_admin', 'rejected_final', 'rejected_hold'].includes(row.target_post_image_status)
              ? null
              : (row.target_post_image || null),
            targetPostIsHidden: row.target_post_ai_status === 'hidden' || ['rejected_admin', 'rejected_final', 'rejected_hold'].includes(row.target_post_image_status),
            targetPostLabel: row.target_post_ai_label || null,
            originalText: row.original_text,
            imageUrl: row.image_url || null,
            aiPredictedLabel: row.ai_predicted_label,
            aiConfidence: Number(row.ai_confidence) || 0.90,
            aiActionTaken: row.ai_action_taken,
            appealReason: row.appeal_reason,
            status: row.status,
            adminNotes: row.admin_notes || '',
            createdAt: new Date(row.created_at).toLocaleString('vi-VN'),
            _sortTime: new Date(row.created_at).getTime() || 0,
          }));

          let groupAppeals = [];
          try {
            const gq = `
              SELECT a.id, a.group_id, g.name AS group_name, a.post_id, a.user_id,
                     u.full_name AS user_name, u.avatar_url AS user_avatar, u.username,
                     a.appeal_reason, a.status, a.admin_notes, a.created_at,
                     p.content AS post_content, p.image_url AS post_image_url,
                     p.ai_label, p.ai_confidence, p.ai_action, p.image_moderation
              FROM community_group_appeals a
              JOIN users u ON u.id = a.user_id
              JOIN community_group_posts p ON p.id = a.post_id
              JOIN community_groups g ON g.id = a.group_id
              ORDER BY CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END, a.created_at DESC
            `;
            const gRes = await pool.query(gq);
            groupAppeals = gRes.rows.map((row) => {
              const imgDecision = row.image_moderation?.decision;
              const imgConfLabel = row.image_moderation?.confidenceLabel;
              let effectiveLabel = row.ai_label || 'Normal';
              if ((imgDecision === 'rejected' || (imgDecision === 'pending_review' && imgConfLabel === 'Bạo lực')) && ['Normal', 'No text', 'Toxic'].includes(effectiveLabel)) {
                effectiveLabel = 'Violence';
              } else if ((imgDecision === 'sensitive' || (imgDecision === 'pending_review' && imgConfLabel === 'Nhạy cảm')) && ['Normal', 'No text'].includes(effectiveLabel)) {
                effectiveLabel = 'Toxic';
              }
              return {
                id: `group-appeal-${row.id}`,
                user: {
                  id: row.user_id,
                  name: row.user_name || 'Người dùng',
                  avatar: row.user_avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400',
                  username: row.username || 'user',
                },
                contentType: 'group_post',
                contentId: String(row.post_id),
                groupId: String(row.group_id),
                groupName: row.group_name || 'Nhóm cộng đồng',
                targetPostId: null,
                targetPostContent: '',
                targetPostImage: null,
                targetPostIsHidden: false,
                targetPostLabel: null,
                originalText: row.post_content || '[Bài viết hình ảnh trong nhóm]',
                imageUrl: row.post_image_url || null,
                aiPredictedLabel: effectiveLabel,
                aiConfidence: Number(row.ai_confidence) || Number(row.image_moderation?.confidence) || 0.90,
                aiActionTaken: row.ai_action || 'hide',
                appealReason: row.appeal_reason,
                status: row.status,
                adminNotes: row.admin_notes || '',
                createdAt: new Date(row.created_at).toLocaleString('vi-VN'),
                _sortTime: new Date(row.created_at).getTime() || 0,
              };
            });
          } catch (groupErr) {
            console.warn('Không tải được community_group_appeals:', groupErr.message);
          }

          return [...coreAppeals, ...groupAppeals]
            .sort((a, b) => {
              const aPending = a.status === 'pending' ? 0 : 1;
              const bPending = b.status === 'pending' ? 0 : 1;
              if (aPending !== bPending) return aPending - bPending;
              return (b._sortTime || 0) - (a._sortTime || 0);
            })
            .map(({ _sortTime, ...rest }) => rest);
        } catch (err) {
          console.warn('Lỗi lấy appeals từ DB PostgreSQL, chuyển sang in-memory:', err.message);
        }
      }
      return appealsStore;
    },

    /**
     * Gửi khiếu nại mới
     */
    async createAppeal({ userId, user, contentType, contentId, originalText, aiPredictedLabel, aiConfidence, aiActionTaken, appealReason }) {
      if (pool) {
        try {
          let finalUserId = userId;
          if (!finalUserId) {
            const uRes = await pool.query('SELECT id FROM users LIMIT 1');
            if (uRes.rows.length > 0) finalUserId = uRes.rows[0].id;
          }

          if (finalUserId) {
            const numContentId = parseInt(String(contentId || '1').replace(/\D/g, ''), 10) || 1;
            const validContentType = ['post', 'comment', 'message'].includes(contentType) ? contentType : 'post';
            const insertSql = `
              INSERT INTO appeals (user_id, content_type, content_id, original_text, ai_predicted_label, ai_confidence, ai_action_taken, appeal_reason, status)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
              RETURNING *
            `;
            const result = await pool.query(insertSql, [
              finalUserId,
              validContentType,
              numContentId,
              originalText || 'Nội dung khiếu nại',
              aiPredictedLabel || 'Toxic',
              Number(aiConfidence) || 0.90,
              aiActionTaken || 'warn_user',
              appealReason || 'Tôi khiếu nại phán quyết AI.'
            ]);
            const dbAppeal = result.rows[0];
            return {
              fromDb: true,
              data: {
                id: String(dbAppeal.id),
                user: user || { id: finalUserId, name: 'Người khiếu nại' },
                contentType: dbAppeal.content_type,
                contentId: String(dbAppeal.content_id),
                originalText: dbAppeal.original_text,
                aiPredictedLabel: dbAppeal.ai_predicted_label,
                aiConfidence: Number(dbAppeal.ai_confidence),
                aiActionTaken: dbAppeal.ai_action_taken,
                appealReason: dbAppeal.appeal_reason,
                status: dbAppeal.status,
                adminNotes: '',
                createdAt: 'Vừa xong'
              }
            };
          }
        } catch (dbErr) {
          console.warn('Lỗi lưu khiếu nại vào PostgreSQL, dùng in-memory store:', dbErr.message);
        }
      }

      const newAppeal = {
        id: `app-${Date.now()}`,
        user: user || { name: 'Người khiếu nại', avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400' },
        contentType: contentType || 'post',
        contentId: contentId || 'item-id',
        originalText: originalText || '',
        aiPredictedLabel: aiPredictedLabel || 'Toxic',
        aiConfidence: aiConfidence || 0.90,
        aiActionTaken: aiActionTaken || 'warn_user',
        appealReason: appealReason || 'Tôi khiếu nại phán quyết AI.',
        status: 'pending',
        adminNotes: '',
        createdAt: 'Vừa xong'
      };

      appealsStore.unshift(newAppeal);
      return { fromDb: false, data: newAppeal };
    },

    /**
     * Xử lý giải quyết khiếu nại (Transaction an toàn với FOR UPDATE)
     */
    async resolveAppeal({ id, status, adminNotes, newLabel, reviewerId, reviewerName }) {
      const VALID_LABELS = ['Normal', 'Toxic', 'Hate Speech', 'Violence'];
      const finalNewLabel = status === 'approved' ? (newLabel || 'Normal') : null;

      // Xử lý đơn khiếu nại bài viết trong nhóm (group-appeal-<id>) bởi Admin tổng
      if (pool && String(id || '').startsWith('group-appeal-')) {
        const groupAppealId = parseInt(String(id).replace('group-appeal-', ''), 10);
        if (!Number.isNaN(groupAppealId)) {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const checkRes = await client.query(
              `SELECT a.*, p.content AS post_content, p.ai_label AS post_ai_label,
                      p.ai_confidence AS post_ai_confidence, p.image_moderation AS post_image_moderation
               FROM community_group_appeals a
               JOIN community_group_posts p ON p.id = a.post_id
               WHERE a.id = $1 FOR UPDATE OF a`,
              [groupAppealId]
            );
            if (checkRes.rows.length === 0) {
              await client.query('ROLLBACK');
              const err = new Error('Đơn khiếu nại nhóm không tồn tại.');
              err.statusCode = 404;
              throw err;
            }
            const dbApp = checkRes.rows[0];
            if (dbApp.status !== 'pending') {
              await client.query('ROLLBACK');
              const statusText = dbApp.status === 'approved' ? 'đã chấp thuận' : 'đã từ chối';
              const err = new Error(`Khiếu nại này đã được xử lý trước đó (${statusText}).`);
              err.statusCode = 409;
              throw err;
            }

            const updRes = await client.query(
              `UPDATE community_group_appeals
               SET status = $1, admin_notes = $2, reviewed_by = $3, reviewed_at = CURRENT_TIMESTAMP
               WHERE id = $4 AND status = 'pending'
               RETURNING *`,
              [status, adminNotes || '', reviewerId, groupAppealId]
            );
            const updatedRow = updRes.rows[0];
            const oldLabel = dbApp.post_ai_label || 'Violence';

            if (status === 'rejected') {
              if (updatedRow.user_id) {
                await client.query(
                  `INSERT INTO notifications (recipient_id, actor_id, type, content, is_read)
                   VALUES ($1, $2, 'system', 'Khiếu nại của bạn về bài viết trong nhóm đã bị Quản trị viên hệ thống từ chối sau khi xem xét lại.', FALSE)`,
                  [updatedRow.user_id, reviewerId]
                );
              }
            } else if (status === 'approved') {
              if (finalNewLabel === 'Normal') {
                await client.query(
                  `UPDATE community_group_posts
                   SET review_status = 'approved',
                       ai_label = 'Normal',
                       ai_action = 'allow',
                       image_moderation = CASE
                         WHEN image_moderation IS NOT NULL
                           THEN jsonb_set(jsonb_set(image_moderation, '{decision}', '"safe"', true), '{confidenceLabel}', '"An toàn"', true)
                         ELSE NULL
                       END,
                       review_note = $2,
                       reviewed_by = $3,
                       reviewed_at = CURRENT_TIMESTAMP,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE id = $1`,
                  [updatedRow.post_id, adminNotes || 'Admin hệ thống đã chấp thuận khiếu nại và khôi phục bài viết.', reviewerId]
                );

                if (updatedRow.user_id) {
                  await client.query(
                    `UPDATE users
                     SET status = 'active', cooldown_until = NULL, cooldown_reason = NULL,
                         cooldown_violation_text = NULL, updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1`,
                    [updatedRow.user_id]
                  );
                  await client.query(
                    `INSERT INTO notifications (recipient_id, actor_id, type, content, is_read)
                     VALUES ($1, $2, 'system', 'Khiếu nại bài viết trong nhóm đã được Admin hệ thống chấp thuận! Bài viết đã được khôi phục và toàn bộ án phạt đã được gỡ bỏ.', FALSE)`,
                    [updatedRow.user_id, reviewerId]
                  );
                  try {
                    const refundMap = { Toxic: 5, 'Hate Speech': 20, Violence: 35 };
                    const refundAmount = refundMap[oldLabel] || 35;
                    await refundTrustPoints({
                      pool: client,
                      userId: updatedRow.user_id,
                      amount: refundAmount,
                      reason: `Kháng cáo bài viết nhóm #${updatedRow.post_id} thành công (${oldLabel})`,
                      contentId: null,
                    });
                  } catch (trustErr) {
                    console.error('Lỗi hoàn điểm uy tín khi duyệt kháng cáo nhóm:', trustErr.message);
                  }
                }
              } else if (finalNewLabel === 'Violence') {
                await client.query(
                  `UPDATE community_group_posts
                   SET review_status = 'rejected', ai_label = 'Violence', is_pinned = FALSE, pinned_at = NULL, updated_at = CURRENT_TIMESTAMP
                   WHERE id = $1`,
                  [updatedRow.post_id]
                );
                if (updatedRow.user_id) {
                  await client.query(
                    `UPDATE users
                     SET status = 'cooldown',
                         cooldown_until = CURRENT_TIMESTAMP + INTERVAL '10 minutes',
                         cooldown_reason = 'Vi phạm bạo lực trong bài viết nhóm (Thẩm định lại khiếu nại)',
                         cooldown_violation_text = $1,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [dbApp.post_content || '[Hình ảnh bạo lực]', updatedRow.user_id]
                  );
                  await client.query(
                    `INSERT INTO notifications (recipient_id, actor_id, type, content, is_read)
                     VALUES ($1, $2, 'system', 'Bài viết trong nhóm của bạn sau khi thẩm định lại bị xác định vi phạm Bạo lực (Violence). Bạn bị tạm khóa 10 phút.', FALSE)`,
                    [updatedRow.user_id, reviewerId]
                  );
                }
              } else {
                const nextStatus = finalNewLabel === 'Hate Speech' ? 'rejected' : 'approved';
                await client.query(
                  `UPDATE community_group_posts
                   SET review_status = $1, ai_label = $2,
                       is_pinned = CASE WHEN $1 = 'rejected' THEN FALSE ELSE is_pinned END,
                       pinned_at = CASE WHEN $1 = 'rejected' THEN NULL ELSE pinned_at END,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE id = $3`,
                  [nextStatus, finalNewLabel, updatedRow.post_id]
                );
                if (updatedRow.user_id) {
                  await client.query(
                    `UPDATE users
                     SET status = 'active', cooldown_until = NULL, cooldown_reason = NULL,
                         cooldown_violation_text = NULL, updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1 AND status = 'cooldown'`,
                    [updatedRow.user_id]
                  );
                  const notifMsg = finalNewLabel === 'Hate Speech'
                    ? 'Bài viết trong nhóm của bạn sau khi xem xét lại được phân loại là Ngôn từ thù ghét (Hate Speech) và bị ẩn.'
                    : 'Bài viết trong nhóm của bạn sau khi xem xét lại được phân loại là Độc hại (Toxic) và bị giới hạn hiển thị.';
                  await client.query(
                    `INSERT INTO notifications (recipient_id, actor_id, type, content, is_read)
                     VALUES ($1, $2, 'system', $3, FALSE)`,
                    [updatedRow.user_id, reviewerId, notifMsg]
                  );
                }
              }
            }

            await client.query(
              `INSERT INTO community_group_moderation_logs
                 (group_id, actor_id, target_type, target_post_id, target_user_id, action, reason)
               VALUES ($1, $2, 'appeal', $3, $4, $5, $6)`,
              [updatedRow.group_id, reviewerId, updatedRow.post_id, updatedRow.user_id, status, adminNotes || '']
            );

            await client.query('COMMIT');
            return {
              appeal: {
                id: `group-appeal-${updatedRow.id}`,
                userId: updatedRow.user_id,
                contentType: 'group_post',
                contentId: String(updatedRow.post_id),
                groupId: String(updatedRow.group_id),
                originalText: dbApp.post_content || '',
                aiPredictedLabel: oldLabel,
                aiConfidence: Number(dbApp.post_ai_confidence) || 0.90,
                status: updatedRow.status,
                adminNotes: updatedRow.admin_notes || '',
                newLabel: finalNewLabel,
                oldLabel,
              },
              createdOverrideLog: null,
            };
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
          } finally {
            client.release();
          }
        }
      }

      const numId = parseInt(id, 10);
      let updatedAppeal = null;
      let createdOverrideLog = null;

      if (pool && !isNaN(numId)) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const checkRes = await client.query('SELECT * FROM appeals WHERE id = $1 FOR UPDATE', [numId]);
          if (checkRes.rows.length === 0) {
            await client.query('ROLLBACK');
            const err = new Error('Đơn khiếu nại không tồn tại.');
            err.statusCode = 404;
            throw err;
          }

          const dbApp = checkRes.rows[0];

          if (dbApp.status !== 'pending') {
            await client.query('ROLLBACK');
            const statusText = dbApp.status === 'approved' ? 'đã chấp thuận' : 'đã từ chối';
            const err = new Error(`Khiếu nại này đã được xử lý trước đó (${statusText}).`);
            err.statusCode = 409;
            throw err;
          }

          const updateSql = `
            UPDATE appeals
            SET status = $1, admin_notes = $2, reviewed_by = $3, reviewed_at = CURRENT_TIMESTAMP
            WHERE id = $4 AND status = 'pending'
            RETURNING *
          `;
          const result = await client.query(updateSql, [status, adminNotes || '', reviewerId, numId]);
          if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            const err = new Error('Khiếu nại này đã được xử lý trước đó bởi người khác.');
            err.statusCode = 409;
            throw err;
          }

          const updatedRow = result.rows[0];
          let notificationPostId = updatedRow.content_type === 'post' ? updatedRow.content_id : null;
          if (updatedRow.content_type === 'comment') {
            const parentPost = await client.query('SELECT post_id FROM comments WHERE id = $1', [updatedRow.content_id]);
            notificationPostId = parentPost.rows[0]?.post_id || null;
          }
          updatedAppeal = {
            id: String(updatedRow.id),
            userId: updatedRow.user_id,
            contentType: updatedRow.content_type,
            contentId: String(updatedRow.content_id),
            originalText: updatedRow.original_text,
            aiPredictedLabel: updatedRow.ai_predicted_label,
            aiConfidence: Number(updatedRow.ai_confidence),
            status: updatedRow.status,
            adminNotes: updatedRow.admin_notes,
            newLabel: finalNewLabel,
            oldLabel: updatedRow.ai_predicted_label
          };

          if (status === 'rejected') {
            if (updatedRow.user_id) {
              await client.query(
                `INSERT INTO notifications (recipient_id, actor_id, type, content, is_read, target_post_id)
                 VALUES ($1, $2, 'system', 'Khiếu nại của bạn về nội dung vi phạm đã bị từ chối sau khi xem xét lại.', FALSE, $3)`,
                [updatedRow.user_id, reviewerId, notificationPostId]
              );
            }
          } else if (status === 'approved') {
            if (finalNewLabel === 'Normal') {
              if (updatedRow.content_type === 'post') {
                await client.query(
                  `UPDATE posts 
                   SET ai_status = 'approved', ai_label = 'Normal',
                       image_moderation_status = CASE WHEN image_url IS NOT NULL THEN 'safe' ELSE NULL END,
                       image_moderation_label = CASE WHEN image_url IS NOT NULL THEN 'safe' ELSE NULL END
                   WHERE id = $1`,
                  [updatedRow.content_id]
                );
              } else if (updatedRow.content_type === 'comment') {
                await client.query(
                  `UPDATE comments 
                   SET is_hidden = FALSE, ai_label = 'Normal',
                       image_moderation_status = CASE WHEN image_url IS NOT NULL THEN 'safe' ELSE NULL END,
                       image_moderation_label = CASE WHEN image_url IS NOT NULL THEN 'safe' ELSE NULL END
                   WHERE id = $1`,
                  [updatedRow.content_id]
                );
              }

              if (updatedRow.user_id) {
                await client.query(
                  `UPDATE users 
                   SET status = 'active', 
                       cooldown_until = NULL, 
                       cooldown_reason = NULL, 
                       cooldown_violation_text = NULL,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE id = $1`,
                  [updatedRow.user_id]
                );

                await client.query(
                  `INSERT INTO notifications (recipient_id, actor_id, type, content, is_read, target_post_id)
                   VALUES ($1, $2, 'system', 'Khiếu nại được chấp thuận! Nội dung của bạn đã được xác nhận an toàn (Normal). Toàn bộ án phạt (cooldown/hạn chế) đã được gỡ bỏ.', FALSE, $3)`,
                  [updatedRow.user_id, reviewerId, notificationPostId]
                );

                try {
                  const refundMap = { 'Toxic': 5, 'Hate Speech': 20, 'Violence': 35 };
                  let refundAmount = refundMap[updatedRow.ai_predicted_label] || 20;

                  // Tra cứu trong user_trust_logs xem trước đó nội dung này bị trừ chính xác bao nhiêu điểm
                  if (updatedRow.content_id) {
                    try {
                      const logCheck = await client.query(
                        `SELECT change_amount FROM user_trust_logs 
                         WHERE user_id = $1 AND content_id = $2 AND change_amount < 0 
                         ORDER BY created_at DESC LIMIT 1`,
                        [updatedRow.user_id, updatedRow.content_id]
                      );
                      if (logCheck.rows.length > 0) {
                        refundAmount = Math.abs(Number(logCheck.rows[0].change_amount));
                      }
                    } catch (lookupErr) {
                      console.warn('Lỗi tra cứu log điểm phạt cũ:', lookupErr.message);
                    }
                  }

                  await refundTrustPoints({
                    pool: client,
                    userId: updatedRow.user_id,
                    amount: refundAmount,
                    reason: `Kháng cáo thành công, minh oan nội dung (${updatedRow.ai_predicted_label || 'Vi phạm'})`,
                    contentId: updatedRow.content_id,
                  });
                } catch (trustErr) {
                  console.error('Lỗi hoàn điểm uy tín khi duyệt kháng cáo:', trustErr.message);
                }
              }
            } else if (finalNewLabel === 'Violence') {
              if (updatedRow.content_type === 'post') {
                await client.query(
                  `UPDATE posts SET ai_status = 'hidden', ai_label = 'Violence', is_pinned = FALSE, pinned_at = NULL WHERE id = $1`,
                  [updatedRow.content_id]
                );
              } else if (updatedRow.content_type === 'comment') {
                await client.query(
                  `UPDATE comments SET is_hidden = TRUE, ai_label = 'Violence' WHERE id = $1`,
                  [updatedRow.content_id]
                );
              }

              if (updatedRow.user_id) {
                await client.query(
                  `UPDATE users 
                   SET status = 'cooldown', 
                       cooldown_until = CURRENT_TIMESTAMP + INTERVAL '10 minutes', 
                       cooldown_reason = 'Vi phạm bạo lực trong nội dung (Khiếu nại được thẩm định lại)',
                       cooldown_violation_text = $1,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE id = $2`,
                  [updatedRow.original_text, updatedRow.user_id]
                );

                await client.query(
                  `INSERT INTO notifications (recipient_id, actor_id, type, content, is_read, target_post_id)
                   VALUES ($1, $2, 'system', 'Nội dung của bạn sau khi thẩm định lại bị xác định vi phạm Bạo lực (Violence). Bạn bị tạm khóa 10 phút.', FALSE, $3)`,
                  [updatedRow.user_id, reviewerId, notificationPostId]
                );
              }
            } else {
              const postAiStatus = finalNewLabel === 'Hate Speech' ? 'hidden' : 'approved';
              if (updatedRow.content_type === 'post') {
                await client.query(
                  `UPDATE posts SET ai_status = $1, ai_label = $2, is_pinned = CASE WHEN $1 = 'hidden' THEN FALSE ELSE is_pinned END, pinned_at = CASE WHEN $1 = 'hidden' THEN NULL ELSE pinned_at END WHERE id = $3`,
                  [postAiStatus, finalNewLabel, updatedRow.content_id]
                );
              } else if (updatedRow.content_type === 'comment') {
                const isCommentHidden = finalNewLabel === 'Hate Speech';
                const isCommentSoftHidden = finalNewLabel === 'Toxic';
                await client.query(
                  `UPDATE comments SET is_hidden = $1, is_soft_hidden = $2, ai_status = $3, ai_label = $4 WHERE id = $5`,
                  [isCommentHidden, isCommentSoftHidden, isCommentHidden ? 'hidden' : 'approved', finalNewLabel, updatedRow.content_id]
                );
              }

              if (updatedRow.user_id) {
                await client.query(
                  `UPDATE users 
                   SET status = 'active', 
                       cooldown_until = NULL, 
                       cooldown_reason = NULL, 
                       cooldown_violation_text = NULL,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE id = $1 AND status = 'cooldown'`,
                  [updatedRow.user_id]
                );

                const notifMsg = finalNewLabel === 'Hate Speech'
                  ? 'Nội dung của bạn sau khi xem xét lại được phân loại là Ngôn từ thù ghét (Hate Speech) và đã bị ẩn.'
                  : 'Nội dung của bạn sau khi xem xét lại được phân loại là Độc hại (Toxic) và đã bị giới hạn hiển thị.';
                await client.query(
                  `INSERT INTO notifications (recipient_id, actor_id, type, content, is_read, target_post_id)
                   VALUES ($1, $2, 'system', $3, FALSE, $4)`,
                  [updatedRow.user_id, reviewerId, notifMsg, notificationPostId]
                );
              }
            }

            const overrideRes = await client.query(
              `INSERT INTO ai_override_logs (admin_id, content_type, content_id, raw_text, original_ai_label, original_confidence, corrected_label, override_reason)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               RETURNING *`,
              [
                reviewerId,
                updatedRow.content_type,
                updatedRow.content_id,
                updatedRow.original_text,
                updatedRow.ai_predicted_label,
                Number(updatedRow.ai_confidence) || 0.90,
                finalNewLabel,
                adminNotes || (finalNewLabel === 'Normal'
                  ? `Chấp thuận khiếu nại: Minh oan và khôi phục nội dung: ${updatedRow.appeal_reason}`
                  : `Chấp thuận khiếu nại: Hiệu chỉnh nhãn sang ${finalNewLabel}`)
              ]
            );
            if (overrideRes.rows.length > 0) {
              const oRow = overrideRes.rows[0];
              createdOverrideLog = {
                id: String(oRow.id),
                adminName: reviewerName || 'Điều Hành Viên Hệ Thống',
                contentType: oRow.content_type,
                contentId: String(oRow.content_id),
                rawText: oRow.raw_text,
                originalAiLabel: oRow.original_ai_label,
                originalConfidence: Number(oRow.original_confidence) || 0.90,
                correctedLabel: oRow.corrected_label,
                overrideReason: oRow.override_reason,
                isExportedForRetraining: oRow.is_exported_for_retraining,
                createdAt: new Date(oRow.created_at).toLocaleString('vi-VN')
              };
            }
          }

          await client.query('COMMIT');
        } catch (dbErr) {
          await client.query('ROLLBACK');
          if (dbErr.statusCode) throw dbErr;
          console.error('Lỗi transaction xử lý khiếu nại trong PostgreSQL:', dbErr.message);
          const err = new Error('Lỗi máy chủ khi xử lý khiếu nại: ' + dbErr.message);
          err.statusCode = 500;
          throw err;
        } finally {
          client.release();
        }
      }

      // 4. Đồng bộ in-memory store
      const appeal = appealsStore.find(a => String(a.id) === String(id));
      if (appeal) {
        if (appeal.status !== 'pending' && !updatedAppeal) {
          const err = new Error(`Khiếu nại này đã được xử lý trước đó (${appeal.status === 'approved' ? 'đã chấp thuận' : 'đã từ chối'}).`);
          err.statusCode = 409;
          throw err;
        }
        appeal.status = status;
        if (adminNotes !== undefined) appeal.adminNotes = adminNotes;
        appeal.newLabel = finalNewLabel;
      }

      if (status === 'approved' && !createdOverrideLog) {
        createdOverrideLog = {
          id: `ovr-${Date.now()}`,
          adminName: reviewerName || 'Điều Hành Viên Hệ Thống',
          contentType: appeal?.contentType || updatedAppeal?.contentType || 'post',
          contentId: appeal?.contentId || updatedAppeal?.contentId || id,
          rawText: appeal?.originalText || updatedAppeal?.originalText || '',
          originalAiLabel: appeal?.aiPredictedLabel || updatedAppeal?.aiPredictedLabel || 'Toxic',
          originalConfidence: appeal?.aiConfidence || 0.90,
          correctedLabel: finalNewLabel,
          overrideReason: adminNotes || (finalNewLabel === 'Normal' ? 'Chấp thuận khiếu nại: Minh oan và khôi phục nội dung' : `Chấp thuận khiếu nại: Gán lại nhãn ${finalNewLabel}`),
          isExportedForRetraining: false,
          createdAt: new Date().toLocaleString('vi-VN')
        };
      }

      if (createdOverrideLog) {
        aiOverrideLogsStore.unshift(createdOverrideLog);
      }

      return {
        appeal: updatedAppeal || appeal,
        createdOverrideLog,
        finalNewLabel,
      };
    }
  };
}

