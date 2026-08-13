import { Redirect } from 'expo-router';
import { View } from 'react-native';

import { useAuth } from '../src/context/AuthContext';
import { colors } from '../src/theme';

export default function Index() {
  const { session, loading } = useAuth();

  if (loading) {
    // A plain themed placeholder instead of `null` - `null` renders nothing,
    // which flashes the page's default (light) background until the async
    // session check resolves. That flash is brief on a warm reload but can
    // be clearly visible on a slower first load, which is what made the
    // auth screens look "wrong" until a refresh. This never redesigns
    // anything - it just avoids an unstyled blank frame before the real
    // redirect/screen renders.
    return <View style={{ flex: 1, backgroundColor: colors.bgDark }} />;
  }

  return <Redirect href={session ? '/(tabs)' : '/(auth)/login'} />;
}
