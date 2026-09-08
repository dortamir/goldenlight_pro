import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import AdminShell from '../components/admin/AdminShell';
import AppInput from '../components/common/AppInput';
import PrimaryButton from '../components/common/PrimaryButton';
import { useAuth } from '../context/AuthContext';
import {
  addAdminUser,
  getAdminUsers,
  getAdminUsersErrorMessage,
  removeAdminUser,
  searchAdminCandidates,
} from '../services/adminUsersService';
import { colors, radius, shadows, spacing, typography } from '../theme';
import { isolateLTR } from '../utils/bidiText';

// Debounce delay before a search keystroke actually fires the server-side
// RPC (adminUsersService.searchAdminCandidates) - long enough that normal
// typing speed never fires one request per keystroke, short enough that the
// results still feel immediate. No shared debounce utility exists elsewhere
// in this codebase yet, so this is a small, local, dependency-free
// setTimeout/clearTimeout pattern rather than a new shared abstraction for a
// single call site.
const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_MIN_QUERY_LENGTH = 2;

function formatAdminSinceDate(value) {
  const date = new Date(value);

  if (!value || Number.isNaN(date.getTime())) {
    return '';
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

export default function AdminUsersScreen() {
  const { user } = useAuth();

  const [admins, setAdmins] = useState([]);
  const [adminsLoading, setAdminsLoading] = useState(true);
  const [adminsError, setAdminsError] = useState('');
  // STAGE 31: same hasLoaded-ref stale-while-refresh pattern already used
  // across every other admin/customer list screen in this app (see
  // AdminHomeScreen.js's own hasLoadedSummaryRef/hasLoadedQueueRef) - only
  // the true first load blocks with a full-screen spinner; a background
  // refresh-on-focus (or the explicit reload after a promotion/removal
  // below) keeps the last-good roster visible the whole time.
  const hasLoadedAdminsRef = useRef(false);

  const loadAdmins = useCallback(() => {
    const isInitialLoad = !hasLoadedAdminsRef.current;

    if (isInitialLoad) {
      setAdminsLoading(true);
    }
    setAdminsError('');

    return getAdminUsers()
      .then((data) => {
        setAdmins(data);
        hasLoadedAdminsRef.current = true;
      })
      .catch((err) => {
        // STAGE 31.2: the real error (code/message/details/hint) is already
        // logged dev-only inside adminUsersService.js itself, at the exact
        // point the RPC call fails - no need to log it again here too.
        if (isInitialLoad) {
          setAdmins([]);
          setAdminsError(getAdminUsersErrorMessage(err));
        }
      })
      .finally(() => {
        setAdminsLoading(false);
      });
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadAdmins();
    }, [loadAdmins]),
  );

  // --- Add admin flow -----------------------------------------------------
  const [addModalOpen, setAddModalOpen] = useState(false);
  // 'search' - typing/browsing candidates. 'confirm' - a candidate was
  // tapped and is awaiting explicit confirmation before the actual
  // promotion RPC call.
  const [addStep, setAddStep] = useState('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState('');

  const openAddModal = () => {
    setAddModalOpen(true);
    setAddStep('search');
    setSearchQuery('');
    setSearchResults([]);
    setSearchError('');
    setSelectedCandidate(null);
    setPromoteError('');
    setRemovalSuccessMessage('');
  };

  const closeAddModal = () => {
    if (promoting) {
      return;
    }
    setAddModalOpen(false);
  };

  // Server-side search only, debounced - never fetches or filters a full
  // user list client-side (see searchAdminCandidates's own comment). Only
  // active while the modal is actually open on the search step, so closing
  // the modal mid-type can never fire (or apply the result of) a stale
  // request.
  useEffect(() => {
    if (!addModalOpen || addStep !== 'search') {
      return undefined;
    }

    const trimmed = searchQuery.trim();

    if (trimmed.length < SEARCH_MIN_QUERY_LENGTH) {
      setSearchResults([]);
      setSearchError('');
      setSearchLoading(false);
      return undefined;
    }

    setSearchLoading(true);
    setSearchError('');

    const timeoutId = setTimeout(() => {
      searchAdminCandidates(trimmed)
        .then((results) => {
          setSearchResults(results);
        })
        .catch((err) => {
          // STAGE 31.2: already logged dev-only inside adminUsersService.js.
          setSearchResults([]);
          setSearchError(getAdminUsersErrorMessage(err));
        })
        .finally(() => {
          setSearchLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [addModalOpen, addStep, searchQuery]);

  const selectCandidate = (candidate) => {
    setSelectedCandidate(candidate);
    setPromoteError('');
    setAddStep('confirm');
  };

  const backToSearch = () => {
    if (promoting) {
      return;
    }
    setAddStep('search');
    setPromoteError('');
  };

  const confirmPromotion = () => {
    if (!selectedCandidate || promoting) {
      return;
    }

    setPromoting(true);
    setPromoteError('');

    addAdminUser(selectedCandidate.user_id)
      .then(() => {
        setAddModalOpen(false);
        loadAdmins();
      })
      .catch((err) => {
        // STAGE 31.2: already logged dev-only inside adminUsersService.js.
        setPromoteError(getAdminUsersErrorMessage(err));
      })
      .finally(() => {
        setPromoting(false);
      });
  };

  // --- Remove admin flow ---------------------------------------------------
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  // STAGE 31.3: a simple, transient Hebrew success message shown above the
  // list after a removal actually succeeds - this app has no shared toast/
  // snackbar component to reuse, so this is a small local state + timeout,
  // not a new shared UI pattern. Cleared automatically after a few seconds,
  // and also cleared immediately if the admin starts another action (opens
  // the add-admin modal or another removal) so it never lingers stale next
  // to an unrelated action.
  const [removalSuccessMessage, setRemovalSuccessMessage] = useState('');
  const removalSuccessTimeoutRef = useRef(null);

  useEffect(
    () => () => {
      if (removalSuccessTimeoutRef.current) {
        clearTimeout(removalSuccessTimeoutRef.current);
      }
    },
    [],
  );

  const openRemoveModal = (admin) => {
    setRemoveTarget(admin);
    setRemoveError('');
    setRemovalSuccessMessage('');
  };

  const closeRemoveModal = () => {
    if (removing) {
      return;
    }
    setRemoveTarget(null);
    setRemoveError('');
  };

  const confirmRemoval = () => {
    if (!removeTarget || removing) {
      return;
    }

    setRemoving(true);
    setRemoveError('');

    removeAdminUser(removeTarget.user_id)
      .then(() => {
        setRemoveTarget(null);
        loadAdmins();

        setRemovalSuccessMessage('הרשאת הניהול הוסרה בהצלחה.');
        if (removalSuccessTimeoutRef.current) {
          clearTimeout(removalSuccessTimeoutRef.current);
        }
        removalSuccessTimeoutRef.current = setTimeout(() => {
          setRemovalSuccessMessage('');
        }, 4000);
      })
      .catch((err) => {
        // STAGE 31.2: already logged dev-only inside adminUsersService.js.
        setRemoveError(getAdminUsersErrorMessage(err));
      })
      .finally(() => {
        setRemoving(false);
      });
  };

  return (
    <AdminShell activeKey="users">
      <View style={styles.pageHeader}>
        <Text style={styles.pageEyebrow}>ניהול הרשאות</Text>
        <Text style={styles.pageTitle}>ניהול מנהלים</Text>
        <Text style={styles.pageSubtitle}>הוספה והסרה של מנהלי מערכת GOLDEN+</Text>
      </View>

      <PrimaryButton title="+ הוספת מנהל" onPress={openAddModal} style={styles.addButton} />

      {/* STAGE 31.3: transient success confirmation after a removal - see
          removalSuccessMessage's own comment above for why this is a small
          local state/timeout rather than a new shared toast component. */}
      {removalSuccessMessage ? (
        <View style={styles.successBanner}>
          <Ionicons name="checkmark-circle" size={16} color={colors.success} />
          <Text style={styles.successBannerText}>{removalSuccessMessage}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{`מנהלים פעילים${
          !adminsLoading && !adminsError && admins.length > 0 ? ` ${isolateLTR(`(${admins.length})`)}` : ''
        }`}</Text>

        {adminsLoading ? (
          <View style={styles.stateCard}>
            <ActivityIndicator color={colors.primary} size="small" />
          </View>
        ) : adminsError ? (
          <View style={styles.stateCard}>
            <Text style={styles.errorText}>{adminsError}</Text>
            <Pressable onPress={loadAdmins} accessibilityRole="button">
              <Text style={styles.retryText}>נסו שוב</Text>
            </Pressable>
          </View>
        ) : admins.length === 0 ? (
          <View style={styles.stateCard}>
            <Text style={styles.emptyText}>לא נמצאו מנהלים</Text>
          </View>
        ) : (
          <View style={styles.adminList}>
            {admins.map((admin) => {
              const isSelf = admin.user_id === user?.id;
              const sinceDate = formatAdminSinceDate(admin.created_at);

              return (
                <View key={admin.user_id} style={styles.adminRow}>
                  <View style={styles.adminRowTop}>
                    <View style={styles.adminAvatar}>
                      <Ionicons name="person" size={18} color={colors.primary} />
                    </View>

                    <View style={styles.adminInfo}>
                      <Text style={styles.adminName} numberOfLines={1}>
                        {admin.full_name || 'משתמש ללא שם'}
                      </Text>
                      {admin.email ? (
                        <Text style={styles.adminEmail} numberOfLines={1}>
                          {isolateLTR(admin.email)}
                        </Text>
                      ) : null}
                      {sinceDate ? (
                        <Text style={styles.adminSince} numberOfLines={1}>
                          {`מנהל מאז ${isolateLTR(sinceDate)}`}
                        </Text>
                      ) : null}
                    </View>
                  </View>

                  {/* STAGE 31.3: the current signed-in admin's own row shows
                      a small label instead of a remove action - never a
                      button, so self-removal is impossible from this
                      screen's UI regardless of what the server also
                      independently enforces (remove_admin_user rejects
                      target_user_id = auth.uid() server-side either way -
                      see adminUsersService.js/029's own comments). Every
                      OTHER row shows a visible, clearly-labeled destructive
                      action - not icon-only - so removing an admin's access
                      is obvious, not hidden behind an unlabeled icon. */}
                  <View style={styles.adminRowFooter}>
                    {isSelf ? (
                      <View style={styles.selfBadge}>
                        <Text style={styles.selfBadgeText}>המנהל הנוכחי</Text>
                      </View>
                    ) : (
                      <Pressable
                        onPress={() => openRemoveModal(admin)}
                        style={({ pressed, hovered }) => [
                          styles.removeButton,
                          hovered && styles.removeButtonHovered,
                          pressed && styles.removeButtonPressed,
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={`הסרת הרשאת מנהל מ${admin.full_name || 'משתמש ללא שם'}`}>
                        <Ionicons name="person-remove-outline" size={14} color={colors.error} />
                        <Text style={styles.removeButtonText}>הסרת הרשאת מנהל</Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </View>

      {/* Add-admin modal: search step, then an explicit confirm step - never
          promotes directly from a search-result tap. */}
      <Modal visible={addModalOpen} transparent animationType="fade" onRequestClose={closeAddModal}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            {addStep === 'search' ? (
              <>
                <Text style={styles.modalTitle}>הוספת מנהל</Text>
                <Text style={styles.modalLabel}>חיפוש לפי שם או אימייל</Text>
                <AppInput
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="הקלידו שם או אימייל..."
                  accessibilityLabel="חיפוש משתמש להוספה כמנהל"
                  autoFocus
                />

                <View style={styles.searchResultsWrap}>
                  {searchQuery.trim().length < SEARCH_MIN_QUERY_LENGTH ? (
                    <Text style={styles.modalHintText}>יש להקליד לפחות 2 תווים כדי לחפש</Text>
                  ) : searchLoading ? (
                    <View style={styles.searchStateBox}>
                      <ActivityIndicator color={colors.primary} size="small" />
                    </View>
                  ) : searchError ? (
                    <Text style={styles.modalErrorText}>{searchError}</Text>
                  ) : searchResults.length === 0 ? (
                    <Text style={styles.modalHintText}>לא נמצאו משתמשים תואמים</Text>
                  ) : (
                    <View style={styles.searchResultsList}>
                      {searchResults.map((candidate) => (
                        <Pressable
                          key={candidate.user_id}
                          onPress={() => selectCandidate(candidate)}
                          style={({ pressed, hovered }) => [
                            styles.searchResultRow,
                            hovered && styles.searchResultRowHovered,
                            pressed && styles.searchResultRowPressed,
                          ]}
                          accessibilityRole="button"
                          accessibilityLabel={`בחירת ${candidate.full_name || 'משתמש ללא שם'} להוספה כמנהל`}>
                          <Text style={styles.searchResultName} numberOfLines={1}>
                            {candidate.full_name || 'משתמש ללא שם'}
                          </Text>
                          {candidate.email ? (
                            <Text style={styles.searchResultEmail} numberOfLines={1}>
                              {isolateLTR(candidate.email)}
                            </Text>
                          ) : null}
                        </Pressable>
                      ))}
                    </View>
                  )}
                </View>

                <View style={styles.modalActionsRow}>
                  <Pressable onPress={closeAddModal} style={styles.modalCancelButton} accessibilityRole="button">
                    <Text style={styles.modalCancelText}>ביטול</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <Text style={styles.modalTitle}>הוספת מנהל</Text>
                <Text style={styles.modalSubtitle}>
                  {selectedCandidate?.full_name || 'משתמש ללא שם'}
                </Text>
                {selectedCandidate?.email ? (
                  <Text style={styles.modalSubtitle}>{isolateLTR(selectedCandidate.email)}</Text>
                ) : null}
                <Text style={styles.modalBodyText}>
                  המשתמש יקבל גישה מלאה למערכת הניהול של GOLDEN+, כולל בדיקת חשבוניות, עריכת פריטים, אישור/דחייה
                  והענקת נקודות.
                </Text>
                {promoteError ? <Text style={styles.modalErrorText}>{promoteError}</Text> : null}
                <View style={styles.modalActionsRow}>
                  <Pressable
                    onPress={backToSearch}
                    disabled={promoting}
                    style={styles.modalCancelButton}
                    accessibilityRole="button">
                    <Text style={styles.modalCancelText}>חזרה</Text>
                  </Pressable>
                  <PrimaryButton
                    title={promoting ? 'מוסיף...' : 'אישור הוספה'}
                    onPress={confirmPromotion}
                    loading={promoting}
                    disabled={promoting}
                    style={styles.modalConfirmButton}
                  />
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Remove-admin confirmation modal. */}
      <Modal visible={Boolean(removeTarget)} transparent animationType="fade" onRequestClose={closeRemoveModal}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>הסרת הרשאת מנהל</Text>
            <Text style={styles.modalBodyText}>
              {`להסיר את הרשאת הניהול של ${removeTarget?.full_name || 'משתמש ללא שם'}?`}
            </Text>
            {removeTarget?.email ? (
              <Text style={styles.modalSubtitle}>{isolateLTR(removeTarget.email)}</Text>
            ) : null}
            {removeError ? <Text style={styles.modalErrorText}>{removeError}</Text> : null}
            <View style={styles.modalActionsRow}>
              <Pressable
                onPress={closeRemoveModal}
                disabled={removing}
                style={styles.modalCancelButton}
                accessibilityRole="button">
                <Text style={styles.modalCancelText}>ביטול</Text>
              </Pressable>
              <Pressable
                onPress={confirmRemoval}
                disabled={removing}
                style={[styles.removeConfirmButton, removing && styles.removeConfirmButtonDisabled]}
                accessibilityRole="button"
                accessibilityLabel="אישור הסרת הרשאת מנהל">
                {removing ? (
                  <ActivityIndicator color={colors.white} size="small" />
                ) : (
                  <Text style={styles.removeConfirmText}>הסרת הרשאה</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </AdminShell>
  );
}

const styles = StyleSheet.create({
  pageHeader: {
    gap: 2,
  },
  pageEyebrow: {
    ...typography.micro,
    color: colors.textMuted,
    textAlign: 'right',
  },
  pageTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  pageSubtitle: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
  },
  addButton: {
    width: '100%',
  },
  section: {
    gap: spacing.sm,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 22,
    color: colors.text,
    textAlign: 'right',
  },
  stateCard: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  errorText: {
    ...typography.body,
    fontWeight: '700',
    color: colors.error,
    textAlign: 'center',
  },
  retryText: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'center',
  },
  emptyText: {
    ...typography.body,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'center',
  },
  adminList: {
    gap: spacing.sm,
  },
  // STAGE 31.3: restructured from a single horizontal row into a small
  // two-part card - a top info row (avatar/name/email/since-date) and a
  // separate footer row for the self-badge/remove action. This is what
  // lets the remove action be a real, visibly-labeled button ("הסרת הרשאת
  // מנהל", not just an icon) without ever competing for horizontal space
  // with a long name/email on a narrow phone - the footer gets the full
  // row width to itself.
  adminRow: {
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...shadows.sm,
  },
  adminRowTop: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.md,
  },
  adminAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  adminInfo: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-end',
    gap: 2,
  },
  adminName: {
    ...typography.body,
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  adminEmail: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
  adminSince: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
  adminRowFooter: {
    alignItems: 'flex-end',
  },
  // The current signed-in admin's own row - a quiet, non-interactive pill,
  // never a button (see the render's own comment on why self-removal is
  // never even offered here).
  selfBadge: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  selfBadgeText: {
    ...typography.caption,
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
  },
  // Compact red-outlined button, WITH visible text - not icon-only - per
  // the explicit "make sure there is a visible, clear way to remove admin
  // access" requirement.
  removeButton: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.error,
    backgroundColor: colors.errorSoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    cursor: 'pointer',
  },
  removeButtonHovered: {
    opacity: 0.85,
  },
  removeButtonPressed: {
    opacity: 0.7,
  },
  removeButtonText: {
    ...typography.caption,
    fontSize: 12,
    fontWeight: '700',
    color: colors.error,
  },
  successBanner: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.successSoft,
    backgroundColor: colors.successSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  successBannerText: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.success,
    textAlign: 'right',
  },
  modalOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(6, 10, 10, 0.55)',
    padding: spacing.xl,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '85%',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.sm,
    ...shadows.premiumCard,
  },
  modalTitle: {
    ...typography.title,
    color: colors.text,
    textAlign: 'right',
  },
  modalSubtitle: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'right',
  },
  modalLabel: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'right',
    marginTop: spacing.xs,
  },
  modalBodyText: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
  modalHintText: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
  modalErrorText: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.error,
    textAlign: 'right',
  },
  modalActionsRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  modalCancelButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
  },
  modalCancelText: {
    ...typography.body,
    fontWeight: '600',
    color: colors.textMuted,
  },
  modalConfirmButton: {
    flex: 1,
  },
  removeConfirmButton: {
    flex: 1,
    minHeight: 52,
    borderRadius: radius.lg,
    backgroundColor: colors.error,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  removeConfirmButtonDisabled: {
    opacity: 0.5,
  },
  removeConfirmText: {
    fontSize: typography.button.fontSize,
    fontWeight: typography.button.fontWeight,
    color: colors.white,
  },
  searchResultsWrap: {
    minHeight: 44,
  },
  searchStateBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
  },
  searchResultsList: {
    gap: spacing.xs,
    maxHeight: 240,
  },
  searchResultRow: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 2,
    cursor: 'pointer',
  },
  searchResultRowHovered: {
    borderColor: colors.primary,
  },
  searchResultRowPressed: {
    opacity: 0.85,
  },
  searchResultName: {
    ...typography.body,
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  searchResultEmail: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
});
