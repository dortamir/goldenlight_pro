
import { StyleSheet, Text, View } from 'react-native';
import AppScreen from '../components/common/AppScreen';
import { colors, typography } from '../theme';

export default function PurchaseScreen() {
  return (
    <AppScreen backgroundColor={colors.background}>
      <View style={styles.container}>
        <Text style={styles.title}>דיווח רכישה</Text>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: typography.heading.fontSize,
    fontWeight: typography.heading.fontWeight,
    color: colors.text,
    textAlign: 'center',
  },
});
