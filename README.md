# The Library of All Images

An infinite, procedural archive of every possible image that could exist within a defined pixel grid, generated entirely on the client side. Inspired by concepts like Borges' *The Library of Babel*, this project maps an infinite coordinate space (addresses) to procedural images using a deterministic pseudo-random number generator (PRNG).

## Overview

**The Library of All Images** doesn't store a single image file. Instead, it generates them dynamically using a BigInt-based Splitmix64 algorithm. Every string of text or numeric address corresponds uniquely to a seed, which in turn deterministically generates an image pixel by pixel.

Because the seed space is practically infinite (limited only by maximum address string length and computational constraints), the library contains every possible combination of pixels for the given grid sizes (from 8x8 up to 256x256). 

## Architecture & Patterns

The project is built as a pure Vanilla web application with no external dependencies (beyond Google Fonts).

### 1. Procedural Generation Engine (`script.js`)
* **State Management**: Uses a custom suite of **chunk-based hexadecimal string arithmetic** (`hexAdd`, `hexMul`, etc.) for all seeds and pagination calculations. This architectural shift bypasses standard `BigInt` allocation limits (`RangeError`) when navigating the astronomical combinatorial space of a 256x256 grid.
* **PRNG (Splitmix64)**: An extended Splitmix64 algorithm operates on `BigInt` to generate RGB values for each pixel. The massive hex string addresses are chunked into smaller segments and continuously mixed into the PRNG state, ensuring every image is unique and preventing visual overlap.
* **Text Hashing**: A custom, recursive hashing function converts any text input ("Address") into a hexadecimal string seed. It operates asynchronously to prevent main-thread blocking when computing massive text inputs, allowing users to search using words, names, or random phrases.

### 2. Performance & Rendering Constraints
* **Batched Asynchronous Rendering**: Calculating raw pixel data for multiple 256x256 canvases sequentially would lock the main thread. The library mitigates this by chunking the canvas rendering process across multiple `requestAnimationFrame` cycles, keeping the UI responsive.
* **Adaptive Grids**: The grid size (number of images shown per page) automatically scales down as the resolution increases to maintain performance. 8x8 grids display 24 images, while 256x256 grids show only 4.

### 3. User Interface (`style.css` & `index.html`)
* **Aesthetic**: Utilizes a cosmic, "dark academia" aesthetic with warm sepia/gold accents, a starry animated background, and typography blending *IM Fell English* (classic) and *Space Mono* (technical).
* **Interactions**: 
  * "Seek" functionality to jump to specific coordinate addresses.
  * Modal overlay for inspecting individual images, showing precise hexadecimal coordinates and allowing downloads.
  * Grain overlay and shimmer loading animations to enhance the analog, atmospheric feel.

## Getting Started

Because this is a pure Vanilla web application with no build step, modules, or bundlers, you can run the project simply by opening the `index.html` file directly in any modern web browser. No local web server is required.

## Features
* **Infinite Exploration**: Browse sequentially or jump to completely random coordinates in the infinite space.
* **Variable Resolutions**: Toggle between 8x8, 16x16, 32x32, 64x64, 128x128, and 256x256 pixel grid images.
* **Deterministic Output**: The exact same address will always yield the exact same image, allowing coordinates to be shared.
* **Export**: Images can be downloaded directly from the inspection modal as PNGs.
