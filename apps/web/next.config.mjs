/** @type {import('next').NextConfig} */
const nextConfig = {
  // The client is fully static (all game logic lives behind the API), which makes
  // hosting on AWS Amplify cheap: no server-side rendering compute.
  output: 'export',
  reactStrictMode: true,
  transpilePackages: ['@ftt/game-engine', '@ftt/shared-types'],
  images: { unoptimized: true },
};
export default nextConfig;
