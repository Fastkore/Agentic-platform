import type { ExternalProvider } from '../shared/library';
import dropbox from './assets/drive/dropbox.png';
import google from './assets/drive/google.png';
import yandex from './assets/drive/yandex.svg';

export const driveProviderIcons = { dropbox, google, yandex };

export function DriveProviderIcon({ provider }: { provider: ExternalProvider }) {
  return <img className="drive-provider-icon" src={driveProviderIcons[provider]} alt="" width={18} height={18} />;
}
