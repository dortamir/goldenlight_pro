import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import AppBackButton from '../components/common/AppBackButton';
import AppScreen from '../components/common/AppScreen';
import PrimaryButton from '../components/common/PrimaryButton';
import { useAuth } from '../context/AuthContext';
import { getPurchaseReportById, getReceiptSignedUrl } from '../services/purchaseReportService';
import { colors, spacing, typography } from '../theme';

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

function getStatusMeta(status) {
  switch (status) {
    case 'processing':
      return { label: 'בעיבוד', backgroundColor: colors.primarySoft, textColor: colors.primary };
    case 'needs_review':
      return { label: 'נדרשת בדיקה', backgroundColor: colors.surfaceMuted, textColor: colors.textMuted };
    case 'approved':
      return { label: 'אושרה', backgroundColor: colors.successSoft, textColor: colors.success };
    case 'rejected':
      return { label: 'נדחתה', backgroundColor: colors.errorSoft, textColor: colors.error };
    case 'submitted':
    default:
      return { label: 'נשלחה לבדיקה', backgroundColor: colors.primarySoft, textColor: colors.primaryPressed };
  }
}

// Simple hand-drawn outline icons in the app's turquoise accent color.
// No icon library (@expo/vector-icons, react-native-svg, ...) is installed
// in this project, so these are built from plain View/Text primitives to
// avoid adding a new dependency while keeping a consistent outline style.
function PackageIcon({ size = 26, color = colors.primary, style }) {
  const strokeWidth = Math.max(1.5, size * 0.08);
  return (
    <View
      style={[
        {
          width: size,
          height: size * 0.78,
          borderWidth: strokeWidth,
          borderColor: color,
          borderRadius: size * 0.14,
          overflow: 'hidden',
        },
        style,
      ]}>
      <View style={{ marginTop: size * 0.26, height: strokeWidth, backgroundColor: color }} />
    </View>
  );
}

function StarIcon({ size = 26, color = colors.primary, style }) {
  return <Text style={[{ fontSize: size, lineHeight: size * 1.05, color, textAlign: 'center' }, style]}>☆</Text>;
}

function InfoIcon({ size = 22, color = colors.primary, style }) {
  const strokeWidth = Math.max(1.5, size * 0.09);
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: strokeWidth,
          borderColor: color,
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}>
      <Text style={{ fontSize: size * 0.52, fontWeight: '700', color, lineHeight: size * 0.58 }}>i</Text>
    </View>
  );
}

// Reserved for future OCR/product-matching integration. Intentionally not
// rendered anywhere yet, since purchase_reports carries no detected-product
// data today. Once that data exists this row can be mapped over it.
function DetectedProductRow({ product }) {
  return (
    <View style={styles.productRow}>
      <View style={styles.productRowInfo}>
        <Text style={styles.productName}>{product.name}</Text>
        <Text style={styles.productSku}>{`מק"ט ${product.sku}`}</Text>
      </View>
      <View style={styles.productRowMeta}>
        <Text style={styles.productMetaText}>{`${product.quantity} יח׳ × ${product.unitPrice} ₪`}</Text>
        <Text style={styles.productTotalText}>{`סה"כ ${product.lineTotal} ₪`}</Text>
        {product.pointsAwarded ? (
          <Text style={styles.productPointsText}>{`+${product.pointsAwarded} נק׳`}</Text>
        ) : null}
      </View>
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
  const [previewOpen, setPreviewOpen] = useState(false);

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
    }, [id, user?.id, loadImage]),
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
      })
      .catch(() => setError('לא הצלחנו לטעון את פרטי החשבונית'))
      .finally(() => setLoading(false));
  };

  const isPdf = report ? isPdfFile(report.original_filename) : false;
  const statusMeta = report ? getStatusMeta(report.status) : null;
  const showPoints = report?.status === 'approved' && report?.points_awarded > 0;
  const canOpenPreview = !isPdf && imageState.status === 'ready' && Boolean(imageState.url);

  return (
    <AppScreen backgroundColor={colors.background} contentContainerStyle={styles.screenContent}>
      <View style={styles.container}>
        <View style={styles.header}>
          <AppBackButton
            deterministicRoute={backRoute || undefined}
            fallbackRoute="/(tabs)"
            style={styles.headerBackButton}
          />
          <View style={styles.headerTextBlock}>
            <Text style={styles.title}>פרטי חשבונית</Text>
            {report ? <Text style={styles.subtitle}>{`הועלתה ב-${formatReportDate(report.created_at)}`}</Text> : null}
          </View>
        </View>

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
                  <Text style={styles.imagePlaceholderText}>קובץ PDF</Text>
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
              <Text style={styles.summaryCardTitle}>חשבונית</Text>
              <Text style={styles.summaryFilename} numberOfLines={2}>
                {report.original_filename || 'חשבונית'}
              </Text>

              <View style={styles.summaryRow}>
                <Text style={styles.summaryRowLabel}>תאריך העלאה</Text>
                <Text style={styles.summaryRowValue}>{formatReportDate(report.created_at)}</Text>
              </View>

              <View style={styles.summaryRow}>
                <Text style={styles.summaryRowLabel}>סטטוס</Text>
                <View style={[styles.statusBadge, { backgroundColor: statusMeta.backgroundColor }]}>
                  <Text style={[styles.statusBadgeText, { color: statusMeta.textColor }]}>{statusMeta.label}</Text>
                </View>
              </View>
            </View>

            <View style={styles.sectionCard}>
              <Text style={styles.sectionCardTitle}>מוצרי Golden Light שזוהו</Text>
              <View style={styles.pendingBox}>
                <PackageIcon size={26} style={styles.sectionIconWrap} />
                <Text style={styles.pendingBoxTitle}>ממתינים לזיהוי המוצרים בחשבונית</Text>
                <Text style={styles.pendingBoxSubtitle}>
                  לאחר סריקת החשבונית יוצגו כאן מוצרי Golden Light שזוהו.
                </Text>
              </View>
            </View>

            <View style={styles.sectionCard}>
              <Text style={styles.sectionCardTitle}>סיכום נקודות</Text>
              {showPoints ? (
                <View style={styles.pointsAwardedBox}>
                  <Text style={styles.pointsAwardedValue}>{`+${formatNumber(report.points_awarded)} נק׳`}</Text>
                  <Text style={styles.pointsAwardedMeta}>נוספו לחשבון</Text>
                </View>
              ) : report.status === 'approved' ? (
                <View style={styles.pointsNeutralBox}>
                  <Text style={styles.pointsNeutralText}>לא נצברו נקודות עבור חשבונית זו</Text>
                </View>
              ) : (
                <View style={styles.pointsNeutralBox}>
                  <StarIcon size={26} style={styles.sectionIconWrap} />
                  <Text style={styles.pointsNeutralText}>הנקודות יחושבו לאחר אישור החשבונית</Text>
                  <Text style={styles.pointsNeutralSubtext}>לאחר אישור החשבונית יתווספו הנקודות לחשבונך.</Text>
                </View>
              )}
            </View>

            {report.status === 'needs_review' ? (
              <View style={styles.infoCard}>
                <Text style={styles.infoCardTitle}>החשבונית דורשת בדיקה נוספת</Text>
                <Text style={styles.infoCardSubtitle}>נעדכן אתכם לאחר השלמת הבדיקה.</Text>
              </View>
            ) : null}

            {report.status === 'rejected' ? (
              <View style={styles.errorInfoCard}>
                <Text style={styles.errorInfoCardTitle}>החשבונית לא אושרה</Text>
              </View>
            ) : null}

            <View style={styles.noticeCard}>
              <InfoIcon size={22} style={styles.noticeIconWrap} />
              <Text style={styles.noticeTitle}>נעדכן אותך על סטטוס החשבונית</Text>
              <Text style={styles.noticeSubtitle}>תקבל/י הודעה לאחר השלמת הטיפול.</Text>
            </View>
          </>
        )}
      </View>

      <Modal visible={previewOpen} animationType="fade" transparent onRequestClose={() => setPreviewOpen(false)}>
        <SafeAreaView style={styles.previewOverlay}>
          <View style={styles.previewHeader}>
            <Text style={styles.previewTitle}>חשבונית</Text>
            {report ? <Text style={styles.previewDate}>{formatReportDate(report.created_at)}</Text> : null}
          </View>

          <View style={styles.previewBody}>
            {imageState.status === 'ready' && imageState.url ? (
              <Image source={{ uri: imageState.url }} style={styles.previewImage} resizeMode="contain" />
            ) : null}
          </View>

          <PrimaryButton title="סגירה" onPress={() => setPreviewOpen(false)} style={styles.closeButton} />
        </SafeAreaView>
      </Modal>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  screenContent: {
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xl,
    paddingBottom: spacing.huge,
  },
  container: {
    width: '100%',
    gap: spacing.md,
  },
  header: {
    position: 'relative',
    alignItems: 'flex-end',
    paddingTop: 2,
    paddingBottom: 2,
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
    color: colors.text,
    textAlign: 'right',
  },
  subtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: spacing.xs,
    lineHeight: 18,
  },
  loadingState: {
    minHeight: 140,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  errorCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'flex-end',
    gap: spacing.sm,
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
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
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
  summaryCard: {
    backgroundColor: colors.white,
    borderRadius: 18,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'flex-end',
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  summaryCardTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  summaryFilename: {
    width: '100%',
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
  },
  summaryRow: {
    width: '100%',
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.surfaceMuted,
  },
  summaryRowLabel: {
    fontSize: typography.caption.fontSize,
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
    borderRadius: 16,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'flex-end',
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
  },
  sectionCardTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
    marginBottom: spacing.sm,
  },
  sectionIconWrap: {
    marginBottom: 6,
  },
  pendingBox: {
    width: '100%',
    backgroundColor: colors.primarySoft,
    borderRadius: 12,
    padding: spacing.lg,
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
    borderRadius: 12,
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
    borderRadius: 12,
    padding: spacing.lg,
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
  infoCard: {
    backgroundColor: colors.primarySoft,
    borderRadius: 16,
    padding: spacing.lg,
    alignItems: 'flex-end',
    gap: 4,
  },
  infoCardTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  infoCardSubtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
  },
  errorInfoCard: {
    backgroundColor: colors.errorSoft,
    borderRadius: 16,
    padding: spacing.lg,
    alignItems: 'flex-end',
  },
  errorInfoCardTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.error,
    textAlign: 'right',
  },
  statusBadge: {
    flexShrink: 0,
    borderRadius: 999,
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
  noticeCard: {
    width: '100%',
    backgroundColor: colors.primarySoft,
    borderRadius: 16,
    padding: spacing.lg,
    alignItems: 'center',
    gap: 4,
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
