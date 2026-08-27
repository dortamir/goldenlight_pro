import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import AppBackButton from '../components/common/AppBackButton';
import AppScreen from '../components/common/AppScreen';
import PrimaryButton from '../components/common/PrimaryButton';
import { useAuth } from '../context/AuthContext';
import { getEligibleReceiptItems, getPurchaseReportById, getReceiptSignedUrl } from '../services/purchaseReportService';
import { colors, radius, shadows, spacing, typography } from '../theme';
import { isolateLTR } from '../utils/bidiText';
import { getCustomerReceiptStatusMeta } from '../utils/purchaseReportStatus';

function formatReportDate(value) {
  const date = new Date(value);

  if (!value || Number.isNaN(date.getTime())) {
    return '';
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

function formatNumber(value) {
  const numericValue = Number.isFinite(value) ? value : 0;
  return numericValue.toLocaleString('he-IL');
}

function isPdfFile(name) {
  return /\.pdf$/i.test(String(name || ''));
}

// Reserved for future OCR/product-matching integration. Intentionally not
// rendered anywhere yet, since purchase_reports carries no detected-product
// data today. Once that data exists this row can be mapped over it.
function DetectedProductRow({ product }) {
  return (
    <View style={styles.productRow}>
      <View style={styles.productRowInfo}>
        <Text style={styles.productName}>{product.name}</Text>
        <Text style={styles.productSku}>{`מק"ט ${isolateLTR(product.sku)}`}</Text>
      </View>
      <View style={styles.productRowMeta}>
        <Text style={styles.productMetaText}>
          {`${isolateLTR(product.quantity)} יח׳ × ${isolateLTR(`${product.unitPrice} ₪`)}`}
        </Text>
        <Text style={styles.productTotalText}>{`סה"כ ${isolateLTR(`${product.lineTotal} ₪`)}`}</Text>
        {product.pointsAwarded ? (
          <Text style={styles.productPointsText}>{`+${isolateLTR(product.pointsAwarded)} נק׳`}</Text>
        ) : null}
      </View>
    </View>
  );
}

// Renders one CONFIRMED Golden Light receipt line - a receipt_manual_items
// row the admin matched to a real catalog product (match_status =
// 'matched'), returned only by get_my_eligible_receipt_items() (see
// purchaseReportService.js's getEligibleReceiptItems()). Only fields that
// actually have a value are shown; nothing is invented for a missing
// sku/quantity/unit_price/line_total. The ₪ prefix on unit_price/line_total
// is display-only formatting for this customer screen - the underlying
// stored numeric value is unchanged.
function EligibleItemRow({ item }) {
  const details = [];

  if (item.quantity != null) {
    details.push({ key: 'quantity', label: 'כמות', value: isolateLTR(item.quantity) });
  }
  if (item.unit_price != null) {
    details.push({ key: 'unit_price', label: 'מחיר ליחידה', value: isolateLTR(`₪${item.unit_price}`) });
  }
  if (item.line_total != null) {
    details.push({ key: 'line_total', label: 'סה״כ', value: isolateLTR(`₪${item.line_total}`) });
  }
  if (item.sku) {
    details.push({ key: 'sku', label: 'מק״ט', value: isolateLTR(item.sku) });
  }

  return (
    <View style={styles.manualItemCard}>
      <Text style={styles.manualItemDescription}>{item.description}</Text>
      {details.length > 0 ? (
        <View style={styles.manualItemDetailsRow}>
          {details.map((detail) => (
            <View key={detail.key} style={styles.manualItemDetailCell}>
              <Text style={styles.manualItemDetailLabel}>{detail.label}</Text>
              <Text style={styles.manualItemDetailValue}>{detail.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// Maps the safe navigation-origin param (never receipt_path/user_id/signed
// URLs - see HomeScreen.js and PurchaseHistoryScreen.js, the only two
// places that link into this screen) to a deterministic back destination.
// Unrecognized/missing origin intentionally resolves to null so the back
// button falls back to its default canGoBack()-then-fallbackRoute behavior
// instead of guessing - see the AppBackButton usage below.
function resolveBackRoute(origin) {
  if (origin === 'home') {
    return '/(tabs)';
  }

  if (origin === 'history') {
    return '/(tabs)/activity';
  }

  return null;
}

export default function PurchaseReportDetailsScreen() {
  const { id, from } = useLocalSearchParams();
  const { user } = useAuth();
  const backRoute = resolveBackRoute(from);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [imageState, setImageState] = useState({ status: 'idle', url: null });
  const [eligibleItems, setEligibleItems] = useState([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [rootHeight, setRootHeight] = useState(0);
  const [heroHeight, setHeroHeight] = useState(0);

  // Same measured-minHeight approach as HomeScreen/ProfileScreen/
  // PurchaseScreen/RewardsScreen/PurchaseHistoryScreen's dark hero + light
  // sheet (see HomeScreen for the full explanation) - guarantees the light
  // sheet reaches the bottom of the real screen regardless of the
  // flex-grow chain between here and the ScrollView.
  const onRootLayout = useCallback((event) => {
    setRootHeight(event.nativeEvent.layout.height);
  }, []);
  const onHeroLayout = useCallback((event) => {
    setHeroHeight(event.nativeEvent.layout.height);
  }, []);
  const sheetMinHeight =
    rootHeight > 0 && heroHeight > 0 ? rootHeight - heroHeight + radius.xl : undefined;

  const loadImage = useCallback((currentReport, isActiveRef) => {
    if (isPdfFile(currentReport.original_filename) || !currentReport.receipt_path) {
      setImageState({ status: 'idle', url: null });
      return;
    }

    setImageState({ status: 'loading', url: null });

    getReceiptSignedUrl(currentReport.receipt_path)
      .then((url) => {
        if (isActiveRef.current) {
          setImageState({ status: url ? 'ready' : 'error', url });
        }
      })
      .catch(() => {
        if (isActiveRef.current) {
          setImageState({ status: 'error', url: null });
        }
      });
  }, []);

  // Isolated from the main report load on purpose - if this fails for any
  // reason, the receipt image/status/points sections must keep working
  // regardless. An empty result is the normal case for every report with no
  // confirmed Golden Light items yet (still pending review, or genuinely
  // zero eligible items), not an error.
  const loadEligibleItems = useCallback((purchaseReportId, isActiveRef) => {
    getEligibleReceiptItems(purchaseReportId)
      .then((items) => {
        if (isActiveRef.current) {
          setEligibleItems(items);
        }
      })
      .catch(() => {
        if (isActiveRef.current) {
          setEligibleItems([]);
        }
      });
  }, []);

  useFocusEffect(
    useCallback(() => {
      const isActiveRef = { current: true };

      async function loadReport() {
        if (!user?.id || !id) {
          setReport(null);
          setLoading(false);
          setError('');
          setNotFound(true);
          return;
        }

        try {
          setLoading(true);
          setError('');
          setNotFound(false);
          const data = await getPurchaseReportById(id, user.id);

          if (!isActiveRef.current) {
            return;
          }

          if (!data) {
            setReport(null);
            setNotFound(true);
            return;
          }

          setReport(data);
          loadImage(data, isActiveRef);
          setEligibleItems([]);
          loadEligibleItems(data.id, isActiveRef);
        } catch (err) {
          if (isActiveRef.current) {
            setReport(null);
            setError('לא הצלחנו לטעון את פרטי החשבונית');
          }
        } finally {
          if (isActiveRef.current) {
            setLoading(false);
          }
        }
      }

      loadReport();

      return () => {
        isActiveRef.current = false;
      };
    }, [id, user?.id, loadImage, loadEligibleItems]),
  );

  const retryLoad = () => {
    if (!user?.id || !id) {
      return;
    }

    const isActiveRef = { current: true };
    setLoading(true);
    setError('');
    setNotFound(false);
    getPurchaseReportById(id, user.id)
      .then((data) => {
        if (!data) {
          setReport(null);
          setNotFound(true);
          return;
        }

        setReport(data);
        loadImage(data, isActiveRef);
        setEligibleItems([]);
        loadEligibleItems(data.id, isActiveRef);
      })
      .catch(() => setError('לא הצלחנו לטעון את פרטי החשבונית'))
      .finally(() => setLoading(false));
  };

  const isPdf = report ? isPdfFile(report.original_filename) : false;
  const statusMeta = report ? getCustomerReceiptStatusMeta(report.status) : null;
  const showPoints = report?.status === 'approved' && report?.points_awarded > 0;
  const canOpenPreview = !isPdf && imageState.status === 'ready' && Boolean(imageState.url);

  // A rejected/approved report is FINALIZED - no further OCR/product-
  // matching/points/status-update processing will ever happen for it, so
  // sections implying otherwise (pending product detection, pending
  // points, "we'll update you") must not render for either. submitted/
  // processing/needs_review remain genuinely non-final and keep their
  // existing pending UI unchanged.
  const isRejected = report?.status === 'rejected';
  const isApproved = report?.status === 'approved';
  const isFinalized = isRejected || isApproved;
  const isPending = !isFinalized;

  return (
    <View style={styles.root} onLayout={onRootLayout}>
      {/* Full-bleed dark hero, same technique/tokens as HomeScreen/
          ProfileScreen/PurchaseScreen/RewardsScreen/PurchaseHistoryScreen's
          own hero (see HomeScreen for the full explanation), kept compact -
          back button + title/date only, no bulky content. */}
      <LinearGradient
        colors={[colors.bgDark, colors.charcoal]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.heroGradient}
      />

      <AppScreen
        backgroundColor="transparent"
        contentContainerStyle={styles.screenContent}
        style={styles.screenInner}
        // No bottom edge - same reasoning as the other tab-adjacent screens
        // (this route lives under (tabs), which already provides its own
        // clearance below the content).
        edges={['top', 'left', 'right']}>
        <View style={styles.heroSection} onLayout={onHeroLayout}>
          <View style={styles.heroInner}>
            <AppBackButton
              deterministicRoute={backRoute || undefined}
              fallbackRoute="/(tabs)"
              color={colors.mutedOnDark}
              style={styles.headerBackButton}
            />
            <View style={styles.headerTextBlock}>
              <Text style={styles.title}>פרטי חשבונית</Text>
              {report ? (
                <Text style={styles.subtitle}>{`הועלתה ב-${isolateLTR(formatReportDate(report.created_at))}`}</Text>
              ) : null}
            </View>
          </View>
        </View>

        {/* Light content sheet - same full-bleed/rounded-top/measured-
            minHeight pattern as the other screens' own sheet. */}
        <View style={[styles.sheet, sheetMinHeight ? { minHeight: sheetMinHeight } : null]}>
          <View style={styles.sheetInner}>
            {loading ? (
              <View style={styles.loadingState}>
                <ActivityIndicator color={colors.primary} size="small" />
              </View>
            ) : error ? (
              <View style={styles.errorCard}>
                <Text style={styles.errorText}>{error}</Text>
                <Pressable onPress={retryLoad} accessibilityRole="button">
                  <Text style={styles.retryText}>נסו שוב</Text>
                </Pressable>
              </View>
            ) : notFound || !report ? (
              <View style={styles.errorCard}>
                <Text style={styles.errorText}>החשבונית לא נמצאה</Text>
              </View>
            ) : (
              <>
                <Pressable
                  style={styles.imageWrap}
                  onPress={() => canOpenPreview && setPreviewOpen(true)}
                  disabled={!canOpenPreview}
                  accessibilityRole={canOpenPreview ? 'button' : undefined}
                  accessibilityLabel="הגדלת תמונת החשבונית">
                  {isPdf ? (
                    <View style={styles.imagePlaceholder}>
                      <Text style={styles.imagePlaceholderText}>{`קובץ ${isolateLTR('PDF')}`}</Text>
                    </View>
                  ) : imageState.status === 'ready' && imageState.url ? (
                    <Image source={{ uri: imageState.url }} style={styles.receiptImage} resizeMode="contain" />
                  ) : imageState.status === 'loading' ? (
                    <View style={styles.imagePlaceholder}>
                      <ActivityIndicator color={colors.primary} size="small" />
                    </View>
                  ) : (
                    <View style={styles.imagePlaceholder}>
                      <Text style={styles.imagePlaceholderText}>לא ניתן לטעון את התמונה</Text>
                    </View>
                  )}
                </Pressable>

                <View style={styles.summaryCard}>
                  <View style={styles.summaryTopRow}>
                    <Text style={styles.summaryCardTitle}>חשבונית</Text>
                    <Text style={styles.summaryFilename} numberOfLines={1}>
                      {report.original_filename ? isolateLTR(report.original_filename) : 'חשבונית'}
                    </Text>
                  </View>

                  <View style={styles.summaryDivider} />

                  <View style={styles.summaryBottomRow}>
                    <View style={styles.summaryDataItem}>
                      <Text style={styles.summaryRowLabel}>תאריך העלאה</Text>
                      <Text style={styles.summaryRowValue}>{isolateLTR(formatReportDate(report.created_at))}</Text>
                    </View>
                    <View style={styles.summaryDataItem}>
                      <Text style={styles.summaryRowLabel}>סטטוס</Text>
                      <View style={[styles.statusBadge, { backgroundColor: statusMeta.backgroundColor }]}>
                        <Text style={[styles.statusBadgeText, { color: statusMeta.textColor }]}>{statusMeta.label}</Text>
                      </View>
                    </View>
                  </View>
                </View>

                {/* Shows ONLY confirmed Golden Light items (receipt_manual_
                    items rows with match_status = 'matched' - see
                    getEligibleReceiptItems()/get_my_eligible_receipt_items()),
                    exactly the rows that contributed to points_awarded.
                    Unresolved/not-Golden-Light rows never appear here - the
                    RPC itself never returns them, so there is nothing to
                    filter client-side. Hidden entirely once rejected (final
                    state, only the rejection itself needs showing) or once
                    finalized with zero eligible items (a clean empty state,
                    not a misleading placeholder). While still pending
                    review, an empty result shows the "awaiting review"
                    message instead of hiding the section outright. */}
                {!isRejected && eligibleItems.length > 0 ? (
                  <View style={styles.sectionCard}>
                    <View style={styles.sectionHeaderRow}>
                      <View style={styles.sectionIconChip}>
                        <Ionicons name="cube-outline" size={18} color={colors.primary} />
                      </View>
                      <Text style={styles.sectionCardTitle}>{`מוצרי ${isolateLTR('Golden Light')}`}</Text>
                    </View>
                    <View style={styles.manualItemsList}>
                      {eligibleItems.map((item) => (
                        <EligibleItemRow key={item.id} item={item} />
                      ))}
                    </View>
                  </View>
                ) : isPending ? (
                  <View style={styles.sectionCard}>
                    <View style={styles.sectionHeaderRow}>
                      <View style={styles.sectionIconChip}>
                        <Ionicons name="cube-outline" size={18} color={colors.primary} />
                      </View>
                      <Text style={styles.sectionCardTitle}>{`מוצרי ${isolateLTR('Golden Light')}`}</Text>
                    </View>
                    <View style={styles.pendingBox}>
                      <Text style={styles.pendingBoxTitle}>ממתינים לסיום הבדיקה</Text>
                      <Text style={styles.pendingBoxSubtitle}>המוצרים המזכים בנקודות יוצגו לאחר סיום הבדיקה.</Text>
                    </View>
                  </View>
                ) : null}

                {/* Points ARE fully wired up server-side (finalize_purchase_
                    report()/award_purchase_points()) - this section only
                    ever shows the already-awarded, authoritative
                    report.points_awarded (never recomputed client-side from
                    manual items/invoice rows - see purchaseReportService.js's
                    getPurchaseReportById(), which selects it directly). A
                    pending report shows the existing "points will be
                    calculated after approval" message, never how far OCR/
                    admin review has actually progressed. An approved report
                    only shows this section when real points were actually
                    awarded (showPoints) - otherwise the section is hidden
                    entirely rather than showing "0 points", which could
                    misleadingly read as a final "you earned nothing"
                    decision when in fact no points-eligible item existed to
                    award from. A rejected report never shows this section at
                    all - see isFinalized/isRejected above. */}
                {showPoints || isPending ? (
                  <View style={styles.sectionCard}>
                    <View style={styles.sectionHeaderRow}>
                      <View style={styles.sectionIconChip}>
                        <Ionicons name="star-outline" size={18} color={colors.primary} />
                      </View>
                      <Text style={styles.sectionCardTitle}>סיכום נקודות</Text>
                    </View>
                    {showPoints ? (
                      <View style={styles.pointsAwardedBox}>
                        <Text style={styles.pointsAwardedValue}>
                          {`+${isolateLTR(formatNumber(report.points_awarded))} נק׳`}
                        </Text>
                        <Text style={styles.pointsAwardedMeta}>נוספו לחשבון</Text>
                      </View>
                    ) : (
                      <View style={styles.pointsNeutralBox}>
                        <Text style={styles.pointsNeutralText}>הנקודות יחושבו לאחר אישור החשבונית</Text>
                        <Text style={styles.pointsNeutralSubtext}>לאחר אישור החשבונית יתווספו הנקודות לחשבונך.</Text>
                      </View>
                    )}
                  </View>
                ) : null}

                {isRejected ? (
                  <View style={styles.errorInfoCard}>
                    <Text style={styles.errorInfoCardTitle}>אופס... הפעם לא הצלחנו לאשר את החשבונית</Text>
                    <Text style={styles.errorInfoCardSubtitle}>
                      נראה שהפרטים בחשבונית לא התאימו לתנאי הצבירה.
                    </Text>
                    {report.rejection_reason ? (
                      <>
                        <Text style={styles.rejectionReasonLabel}>פרטים נוספים</Text>
                        <Text style={styles.rejectionReasonText}>{report.rejection_reason}</Text>
                      </>
                    ) : null}
                  </View>
                ) : null}

                {/* Final states need no "we'll update you" notice - there
                    is nothing further to update them about. */}
                {isPending ? (
                  <View style={styles.noticeCard}>
                    <Ionicons name="information-circle-outline" size={18} color={colors.primary} style={styles.noticeIconWrap} />
                    <Text style={styles.noticeTitle}>נעדכן אותך על סטטוס החשבונית</Text>
                    <Text style={styles.noticeSubtitle}>תקבל/י הודעה לאחר השלמת הטיפול.</Text>
                  </View>
                ) : null}
              </>
            )}
          </View>
        </View>
      </AppScreen>

      <Modal visible={previewOpen} animationType="fade" transparent onRequestClose={() => setPreviewOpen(false)}>
        <SafeAreaView style={styles.previewOverlay}>
          <View style={styles.previewHeader}>
            <Text style={styles.previewTitle}>חשבונית</Text>
            {report ? <Text style={styles.previewDate}>{isolateLTR(formatReportDate(report.created_at))}</Text> : null}
          </View>

          <View style={styles.previewBody}>
            {imageState.status === 'ready' && imageState.url ? (
              <Image source={{ uri: imageState.url }} style={styles.previewImage} resizeMode="contain" />
            ) : null}
          </View>

          <PrimaryButton title="סגירה" onPress={() => setPreviewOpen(false)} style={styles.closeButton} />
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  heroGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  // Same cancel-AppScreen's-own-wrapper technique as the other screens (see
  // HomeScreen's screenInner comment for the full flex-chain explanation).
  screenInner: {
    flex: 1,
    width: '100%',
    maxWidth: '100%',
    alignSelf: 'stretch',
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  screenContent: {
    flexGrow: 1,
  },
  // Deliberately short - back button + title/date only, no bulky content,
  // matching PurchaseHistoryScreen's own compact secondary-screen hero.
  heroSection: {
    paddingTop: spacing.sm,
    // Extra bottom padding absorbs the sheet's negative marginTop overlap
    // below (see `sheet`), so the rounded corners never cut into the
    // header text.
    paddingBottom: spacing.xl + radius.xl,
  },
  heroInner: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    position: 'relative',
  },
  headerBackButton: {
    position: 'absolute',
    top: 0,
    right: 0,
    zIndex: 1,
  },
  headerTextBlock: {
    width: '100%',
    alignItems: 'flex-end',
    paddingEnd: 56,
  },
  title: {
    fontSize: typography.title.fontSize,
    fontWeight: typography.title.fontWeight,
    color: colors.textOnDark,
    textAlign: 'right',
  },
  subtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.mutedOnDark,
    textAlign: 'right',
    marginTop: spacing.xs,
    lineHeight: 18,
  },
  sheet: {
    flex: 1,
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    marginTop: -radius.xl,
  },
  // Tighter section-to-section rhythm than the tab screens (spacing.md, not
  // .lg) - this is a denser detail screen, not a browsing screen, so
  // "reduce excessive vertical whitespace" takes priority here.
  sheetInner: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  loadingState: {
    minHeight: 140,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  errorCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'flex-end',
    gap: spacing.sm,
    ...shadows.softCard,
  },
  errorText: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.error,
    textAlign: 'right',
  },
  retryText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'right',
  },
  imageWrap: {
    alignSelf: 'center',
    width: '78%',
    maxWidth: 320,
    aspectRatio: 3 / 4,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.softCard,
  },
  receiptImage: {
    width: '100%',
    height: '100%',
  },
  imagePlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  imagePlaceholderText: {
    fontSize: typography.body.fontSize,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'center',
  },
  // Compact metadata card - title+filename share one row, a single hairline
  // divider, then a two-column data row (date, status) below it, rather
  // than the previous per-row bordered stack (which took much more
  // vertical space for the same three facts).
  summaryCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.softCard,
  },
  summaryTopRow: {
    flexDirection: 'row-reverse',
    alignItems: 'baseline',
    gap: spacing.xs,
  },
  summaryCardTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  summaryFilename: {
    flex: 1,
    minWidth: 0,
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
  },
  summaryDivider: {
    height: 1,
    backgroundColor: colors.surfaceMuted,
    marginVertical: spacing.sm,
  },
  summaryBottomRow: {
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryDataItem: {
    alignItems: 'flex-end',
    gap: 2,
  },
  summaryRowLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'right',
  },
  summaryRowValue: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'right',
  },
  sectionCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'flex-end',
    ...shadows.softCard,
  },
  // Icon-chip + title row - the same "family" header treatment shared by
  // the products and points cards, so the two clearly read as one
  // component family rather than unrelated rectangles.
  sectionHeaderRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  sectionIconChip: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionCardTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  pendingBox: {
    width: '100%',
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
    gap: 4,
  },
  pendingBoxTitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  pendingBoxSubtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 16,
  },
  pointsAwardedBox: {
    width: '100%',
    backgroundColor: colors.successSoft,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'flex-end',
    gap: 4,
  },
  pointsAwardedValue: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.success,
    textAlign: 'right',
  },
  pointsAwardedMeta: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.success,
    textAlign: 'right',
  },
  pointsNeutralBox: {
    width: '100%',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
    gap: 4,
  },
  pointsNeutralText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'center',
  },
  pointsNeutralSubtext: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 16,
  },
  errorInfoCard: {
    backgroundColor: colors.errorSoft,
    borderRadius: radius.lg,
    padding: spacing.md,
    alignItems: 'flex-end',
    gap: 4,
  },
  errorInfoCardTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.error,
    textAlign: 'right',
  },
  errorInfoCardSubtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.text,
    textAlign: 'right',
    lineHeight: 18,
  },
  rejectionReasonLabel: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.error,
    textAlign: 'right',
    marginTop: spacing.sm,
  },
  rejectionReasonText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.text,
    textAlign: 'right',
    marginTop: 2,
    lineHeight: 18,
  },
  statusBadge: {
    flexShrink: 0,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  productRow: {
    width: '100%',
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.surfaceMuted,
  },
  productRowInfo: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-end',
  },
  productName: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  productSku: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
  },
  productRowMeta: {
    alignItems: 'flex-end',
    gap: 2,
  },
  productMetaText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
  },
  productTotalText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'right',
  },
  productPointsText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.success,
    textAlign: 'right',
  },
  // Confirmed Golden Light receipt items (EligibleItemRow) - the only rows
  // returned by get_my_eligible_receipt_items() (match_status = 'matched').
  manualItemsList: {
    width: '100%',
    gap: spacing.sm,
  },
  // Each manual item gets its own subtle, tinted inner card (not a hairline
  // -separated text row) so a list of several products reads as distinct,
  // easy-to-scan cards rather than one dense block of text. primarySoft is
  // the same "very light turquoise surface" token already used elsewhere
  // for a premium tinted panel (e.g. PurchaseScreen's infoCard) - no new
  // color introduced. No border - the tint alone separates it from the
  // white outer card.
  manualItemCard: {
    width: '100%',
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  // Visually the dominant element in the card - bolder and a step larger
  // than the caption-sized detail values below it.
  manualItemDescription: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  manualItemDetailsRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.lg,
  },
  manualItemDetailCell: {
    alignItems: 'flex-end',
    gap: 1,
  },
  // Small/muted label, per the requested hierarchy (name > values > labels).
  manualItemDetailLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'right',
  },
  // Medium emphasis - stronger than the label, still clearly secondary to
  // the product name above.
  manualItemDetailValue: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  // Lighter/more compact than the products/points cards - a closing
  // footnote, not a competing section.
  noticeCard: {
    width: '100%',
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    padding: spacing.sm,
    alignItems: 'center',
    gap: 2,
  },
  noticeIconWrap: {
    marginBottom: 4,
  },
  noticeTitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  noticeSubtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'center',
  },
  previewOverlay: {
    flex: 1,
    backgroundColor: 'rgba(11,11,11,0.94)',
    justifyContent: 'space-between',
  },
  previewHeader: {
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
  },
  previewTitle: {
    fontSize: typography.title.fontSize,
    fontWeight: '700',
    color: colors.white,
    textAlign: 'right',
  },
  previewDate: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.surfaceMuted,
    textAlign: 'right',
  },
  previewBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  closeButton: {
    marginHorizontal: spacing.xl,
    marginBottom: spacing.xl,
  },
});
