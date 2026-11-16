import type { Metadata, Viewport } from 'next';
import '@fontsource/patrick-hand/400.css';
import '@fontsource/caveat-brush/400.css';
import '@fontsource/permanent-marker/400.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'FROM THIS TO THAT — the whiteboard word game for couples, near or far',
  description:
    'Change one letter at a time to get from one word to another. Play the viral whiteboard word-ladder game together in real time, even when you are miles apart.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#efe6d8',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
