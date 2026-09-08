import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import AppBackButton from '../components/common/AppBackButton';
import AppScreen from '../components/common/AppScreen';
import { colors, radius, shadows, spacing, typography } from '../theme';
import { isolateLTR } from '../utils/bidiText';

// STAGE 28: development-stage placeholders only - this business information
// has not been provided yet. Each value is deliberately rendered as a
// visible "[נדרש לעדכון...]" marker (never a fabricated name/number/email)
// so it is obvious in review that these must be replaced with real details
// before this screen ships to production. Centralized here, at the top of
// the screen, specifically so they are easy to find and update later
// without touching the render logic below.
const ACCESSIBILITY_CONTACT_NAME = '[נדרש לעדכון]';
const ACCESSIBILITY_CONTACT_PHONE = '[נדרש לעדכון]';
const ACCESSIBILITY_CONTACT_EMAIL = '[נדרש לעדכון]';
// Deliberately a static placeholder, never today's date computed at
// render time - this line must only ever show the real date the statement
// was actually last reviewed/updated, which is not yet known.
const ACCESSIBILITY_STATEMENT_LAST_UPDATED = '[נדרש לעדכון לפני פרסום]';

// A single labeled row inside the "פנייה בנושא נגישות" card - plain text,
// not a Pressable: every value here is still a placeholder (see the
// constants above), so there is nothing real yet to dial/email/navigate to.
// Once real contact details are filled in, a future stage can decide
// whether to wire these into tel:/mailto: actions (matching
// HelpSupportScreen's own pattern) - not done here to avoid ever presenting
// a placeholder as if it were a working contact action.
function ContactRow({ label, value }) {
  return (
    <View style={styles.contactRow}>
      <Text style={styles.contactLabel}>{label}</Text>
      <Text style={styles.contactValue}>{value}</Text>
    </View>
  );
}

export default function AccessibilityStatementScreen() {
  const [rootHeight, setRootHeight] = useState(0);
  const [heroHeight, setHeroHeight] = useState(0);

  // Same measured-minHeight approach as ProfileScreen/EditProfileScreen/
  // HelpSupportScreen's dark hero + light sheet (see HomeScreen for the
  // full explanation) - guarantees the light sheet reaches the bottom of
  // the real screen regardless of the flex-grow chain between here and the
  // ScrollView.
  const onRootLayout = useCallback((event) => {
    setRootHeight(event.nativeEvent.layout.height);
  }, []);
  const onHeroLayout = useCallback((event) => {
    setHeroHeight(event.nativeEvent.layout.height);
  }, []);
  const sheetMinHeight =
    rootHeight > 0 && heroHeight > 0 ? rootHeight - heroHeight + radius.xl : undefined;

  return (
    <View style={styles.root} onLayout={onRootLayout}>
      {/* Full-bleed dark hero, same technique/tokens as ProfileScreen/
          EditProfileScreen/HelpSupportScreen's own hero (see HomeScreen for
          the full explanation), kept compact - back button + title only, no
          bulky content. */}
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
              fallbackRoute="/(tabs)/profile"
              color={colors.mutedOnDark}
              style={styles.headerBackButton}
            />
            <View style={styles.headerTextBlock}>
              <Text style={styles.title}>הצהרת נגישות</Text>
            </View>
          </View>
        </View>

        {/* Light content sheet - same full-bleed/rounded-top/measured-
            minHeight pattern as the other screens' own sheet. */}
        <View style={[styles.sheet, sheetMinHeight ? { minHeight: sheetMinHeight } : null]}>
          <View style={styles.sheetInner}>
            <View style={styles.card}>
              <Text style={styles.bodyText}>
                גולדן לייט רואה חשיבות במתן שירות שוויוני ונגיש לכלל לקוחותיה ומשתמשי אפליקציית{' '}
                {isolateLTR('GOLDEN+')}, לרבות אנשים עם מוגבלות.
              </Text>
              <Text style={[styles.bodyText, styles.bodyTextSpaced]}>
                אנו פועלים לשיפור נגישות השירותים הדיגיטליים שלנו במטרה לאפשר שימוש נוח, ברור ושוויוני
                ככל האפשר ובהתאם להוראות הדין החלות בנושא נגישות.
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionHeading}>נגישות באפליקציה</Text>
              <Text style={styles.bodyText}>
                בפיתוח אפליקציית {isolateLTR('GOLDEN+')} אנו שואפים ליישם עקרונות נגישות בשירותים
                הדיגיטליים, תוך שימוש ביכולות הנגישות הנתמכות על ידי מערכות ההפעלה והמכשירים הניידים.
              </Text>
              <Text style={[styles.bodyText, styles.bodyTextSpaced]}>
                בין היתר, אנו פועלים לשמירה על מבנה מסכים ברור ועקבי, ניגודיות מתאימה בין טקסט לרקע,
                טקסטים קריאים, כפתורים ורכיבי פעולה ברורים ושימוש בתיאורים מתאימים לרכיבים אינטראקטיביים
                ככל שנדרש.
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionHeading}>שימוש בטכנולוגיות מסייעות</Text>
              <Text style={styles.bodyText}>
                האפליקציה מיועדת לפעול בשילוב עם אפשרויות הנגישות הקיימות במכשיר ובמערכת ההפעלה, לרבות
                הגדלת טקסט, התאמות תצוגה וטכנולוגיות מסייעות הנתמכות על ידי המכשיר.
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionHeading}>ייתכנו מגבלות נגישות</Text>
              <Text style={styles.bodyText}>
                אנו ממשיכים לפעול לשיפור נגישות האפליקציה. ייתכן שחלקים מסוימים באפליקציה טרם הונגשו
                באופן מלא או שקיימות בהם מגבלות נגישות.
              </Text>
              <Text style={[styles.bodyText, styles.bodyTextSpaced]}>
                אם נתקלתם בקושי בשימוש באפליקציה או בתוכן שאינו נגיש, נשמח לקבל את פנייתכם ולפעול לבחינת
                הנושא ולמתן מענה מתאים ככל האפשר.
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionHeading}>פנייה בנושא נגישות</Text>
              <Text style={styles.bodyText}>בכל שאלה, בקשה או דיווח בנושא נגישות ניתן לפנות אלינו:</Text>

              <View style={styles.contactList}>
                <ContactRow label="שם איש קשר / רכז נגישות" value={ACCESSIBILITY_CONTACT_NAME} />
                <ContactRow label="טלפון" value={ACCESSIBILITY_CONTACT_PHONE} />
                <ContactRow label={'דוא"ל'} value={ACCESSIBILITY_CONTACT_EMAIL} />
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionHeading}>מועד עדכון ההצהרה</Text>
              <Text style={styles.bodyText}>
                {`הצהרת נגישות זו עודכנה לאחרונה בתאריך: ${ACCESSIBILITY_STATEMENT_LAST_UPDATED}`}
              </Text>
            </View>
          </View>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  // Matches heroGradient's own END color (colors.charcoal), the same fix
  // already proven correct on the physically-approved RewardsScreen.js -
  // not colors.background (the app's default light surface). heroGradient
  // is an absolute-fill decorative layer; if it is ever not yet painted for
  // even one frame (e.g. right on this screen's first mount), root's own
  // background is what actually shows behind it - colors.background made
  // that moment read as a flat light page instead of the intended dark
  // hero, exactly the composition bug this fix corrects. Purely a fallback
  // color - no layout, spacing, or content change.
  root: {
    flex: 1,
    backgroundColor: colors.charcoal,
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
  // Deliberately short - back button + title only, no bulky content,
  // matching ProfileScreen/EditProfileScreen/HelpSupportScreen's own
  // compact secondary-screen hero.
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
  sheet: {
    flex: 1,
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    marginTop: -radius.xl,
  },
  sheetInner: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  card: {
    width: '100%',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.softCard,
  },
  // 18-20px/700-800, per this stage's own explicit typography target - a
  // clearly separated section heading, distinct from the smaller/lighter
  // cardTitle style HelpSupportScreen uses for its own, less formal cards.
  sectionHeading: {
    fontSize: 19,
    lineHeight: 24,
    fontWeight: '800',
    color: colors.text,
    textAlign: 'right',
    marginBottom: spacing.sm,
  },
  // 15-16px/23-25 lineHeight, per this stage's own explicit target - larger
  // and roomier than HelpSupportScreen's own caption-sized body text
  // (12px/20), a deliberate choice for a legal/informational statement
  // that should read comfortably rather than like fine print. Full
  // colors.text (not the muted secondary tone) for strong contrast. No
  // numberOfLines cap anywhere in this screen - every paragraph wraps
  // naturally at any length or font-scale setting, never truncated.
  bodyText: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '400',
    color: colors.text,
    textAlign: 'right',
  },
  bodyTextSpaced: {
    marginTop: spacing.sm,
  },
  contactList: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  contactRow: {
    alignItems: 'flex-end',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  contactLabel: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'right',
  },
  contactValue: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
    marginTop: 2,
  },
});