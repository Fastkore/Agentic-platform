import type { ExternalProvider } from '../shared/library';
import dropbox from './assets/drive/dropbox.png';
import google from './assets/drive/google.png';
import yandex from './assets/drive/yandex.svg';

const icons = { dropbox, google, yandex };

export function DriveProviderIcon({ provider }: { provider: ExternalProvider }) {
  return <img className="drive-provider-icon" src={icons[provider]} alt="" width={18} height={18} />;
}
