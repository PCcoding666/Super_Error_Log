import { IonButton, IonIcon } from '@ionic/react';
import { mic, stop } from 'ionicons/icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { startVoice, voiceSupported, type VoiceSession } from '../lib/voice';

/** 语音输入：点一下开始说，再点一下转成文字交给 onText。浏览器不支持录音就不显示。 */
export function VoiceButton(props: { onText: (text: string) => void; onError: (message: string) => void }): ReactNode {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle');
  const [seconds, setSeconds] = useState(0);
  const session = useRef<VoiceSession | null>(null);
  const { onText, onError } = props;

  useEffect(() => {
    if (phase !== 'recording') return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [phase]);
  useEffect(() => () => session.current?.cancel(), []);

  const finish = async (): Promise<void> => {
    const current = session.current;
    if (!current) return;
    session.current = null;
    setPhase('transcribing');
    try { onText(await current.finish()); }
    catch (caught) { onError(caught instanceof Error ? caught.message : '这次没转成文字，再说一次，或者直接打字。'); }
    finally { setPhase('idle'); }
  };
  const toggle = async (): Promise<void> => {
    if (phase === 'recording') { await finish(); return; }
    if (phase !== 'idle') return;
    setPhase('starting');
    try {
      session.current = await startVoice(() => { void finish(); });
      setSeconds(0);
      setPhase('recording');
    } catch {
      setPhase('idle');
      onError('没法用麦克风：在浏览器设置里允许这个网页使用麦克风，或者直接打字。');
    }
  };

  if (!voiceSupported()) return null;
  const label = phase === 'recording' ? `说完了 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : phase === 'transcribing' ? '正在转成文字…' : '按一下说';
  return <IonButton size="small" fill={phase === 'recording' ? 'solid' : 'outline'} color={phase === 'recording' ? 'danger' : 'primary'} disabled={phase === 'starting' || phase === 'transcribing'}
    onClick={() => void toggle()} data-testid="voice-button" aria-pressed={phase === 'recording'}>
    <IonIcon slot="start" icon={phase === 'recording' ? stop : mic} />{label}
  </IonButton>;
}
