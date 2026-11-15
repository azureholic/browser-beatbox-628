# Beatbox/Drum Machine Specification

## Overview
Create a browser-based beatbox/drum machine with 16 beats and different sounds.

## Clarified Scope
- **Sequencer:** A 16-step sequencer that loops continuously while playing.
- **Sounds:** Multiple distinct drum sounds that can be triggered based off of the sequencer.
- **Playback:** Must be playable within a modern web browser with no additional plugins required.
- **Controls:** Basic transport and tempo controls to allow for user interaction.
- **Visual Feedback:** Clear indication of the current step and active steps to the user.

## Clarifications
- **Is this intended to be a single track (16 steps total) or a multi-track grid (e.g. 4 instruments x 16 steps)?**: 16 beats on a grid, multiple instruments
- **Should the pattern be able to be saved or loaded (e.g. local storage, URL query parameters)? If so, is this required or optional?**: no
- **Are there any mobile device requirements (touch support) or is desktop only?**: no
- **Are there any accessibility requirements (keyboard navigation, ARIA labels, screen reader support)?**: no
- **Is there a specific maximum file size for audio samples, or a preferred method to load them (bundled assets)?**: no
- **Are there any specific sounds that are required (e.g. kick, snare, hi-hat, clap), or can any set be used?**: just pick a nice set
- [001 - Improve Local NPM Installation Reliability](docs/features/001-npm-install-reliability.md)
