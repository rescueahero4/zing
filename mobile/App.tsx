import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { colors } from './src/theme';
import {
  makeItHarder as runMakeItHarder,
  runPipeline,
  type PipelineResult,
  type StageId,
  type WorksheetSource,
} from './src/lib/api';
import { CaptureScreen } from './src/screens/CaptureScreen';
import { GeneratingScreen } from './src/screens/GeneratingScreen';
import { BatchPlayerScreen } from './src/screens/BatchPlayerScreen';
import { HistoryScreen } from './src/screens/HistoryScreen';
import type { Difficulty } from './src/types/batch';

type Mode = 'capture' | 'generating' | 'player' | 'history';

/** Long enough for the last line of the agent narration to land (ARCH §5). */
const READY_DWELL_MS = 800;

/**
 * Root state machine: Capture → Generating → BatchPlayer → (ScoreCard) →
 * Capture, with History hanging off Capture.
 */
export default function App() {
  const [mode, setMode] = useState<Mode>('capture');
  const [stage, setStage] = useState<StageId>('extract');
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [harderBusy, setHarderBusy] = useState(false);

  const onWorksheet = useCallback(async (sources: WorksheetSource[], difficulty: Difficulty) => {
    setStage('extract');
    setMode('generating');

    const pipelineResult = await runPipeline({ sources, difficulty, onStage: setStage });

    // Fresh batch or bundled fallback, the Generating screen finishes its
    // animation either way — the child never sees the seam.
    setTimeout(() => {
      setResult(pipelineResult);
      setMode('player');
    }, READY_DWELL_MS);
  }, []);

  const onMakeItHarder = useCallback(async () => {
    if (!result || harderBusy) return;
    setHarderBusy(true);
    try {
      setResult(await runMakeItHarder(result));
    } finally {
      setHarderBusy(false);
    }
  }, [result, harderBusy]);

  const onDone = useCallback(() => {
    setResult(null);
    setMode('capture');
  }, []);

  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <StatusBar style="light" />

        {mode === 'capture' ? (
          <CaptureScreen onWorksheet={onWorksheet} onOpenHistory={() => setMode('history')} />
        ) : null}

        {mode === 'generating' ? <GeneratingScreen stage={stage} /> : null}

        {mode === 'player' && result ? (
          // Keyed on batchId so "Make it harder" remounts the feed at page 0.
          <BatchPlayerScreen
            key={result.batch.batchId}
            batch={result.batch}
            onMakeItHarder={onMakeItHarder}
            onDone={onDone}
            makeItHarderBusy={harderBusy}
          />
        ) : null}

        {mode === 'history' ? <HistoryScreen onClose={() => setMode('capture')} /> : null}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
