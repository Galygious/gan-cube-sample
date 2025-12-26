# gan-cube-sample

Minimal sample application demonstrating connectivity with GAN Smart Cubes using `gan-web-bluetooth`.

## Core Development Commands
- `npm run dev`: Starts the Vite development server
- `npm run build`: Runs TypeScript compiler and builds for production via Vite
- `npm run preview`: Previews the production build locally

## High-Level Architecture
- **Bluetooth Interface**: Uses `gan-web-bluetooth` for connecting to GAN cubes via Web Bluetooth. It handles Gen2, Gen3, and Gen4 protocols.
- **3D Visualization**: Employs `cubing/twisty`'s `TwistyPlayer` for the cube display.
- **Orientation Sync**: Directly manipulates the internal `three.js` scene of the `TwistyPlayer` to sync physical cube orientation via gyroscope data.
- **State Management**:
    - **Timer**: Managed via a simple state machine (`IDLE`, `READY`, `RUNNING`, `STOPPED`).
    - **Facelets**: Cube state is tracked as facelet strings (Kociemba notation) and converted to `cubing.js` `KPattern` for solver/visualizer compatibility.
- **Event Handling**: Uses RxJS for managing the stream of `GanCubeEvent` (GYRO, MOVE, FACELETS, etc.).

## AI-Relevant Constraints and Conventions
- **Direct Scene Access**: The orientation syncing logic depends on `experimentalCurrentVantages()` and accessing `twistyVantage.scene.scene()`. This is brittle as it relies on internal `cubing.js` APIs.
- **jQuery for UI**: UI interactions and DOM updates are handled via jQuery. Match this pattern for UI changes.
- **Kociemba Notation**: Always use the 54-character facelet string format for internal cube state representations when interacting with `gan-web-bluetooth`.
- **Bluetooth Flags**: Requires `chrome://flags/#enable-experimental-web-platform-features` in Chrome for full functionality (specifically `watchAdvertisements`).
