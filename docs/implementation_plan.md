# Plan: Premium ATC Similar Callsign Warning System Redesign

Redesign the existing monitoring interface to provide a high-end, professional experience for Air Traffic Controllers, while integrating real-time data loading from `similar_callsign.csv`.

## User Review Required

> [!IMPORTANT]
> Since standard browser `fetch()` for local files (`file://` protocol) is often blocked by CORS, I will implement a robust loading mechanism that attempts to fetch the CSV automatically, but also provides a "Refresh Data" or "Upload CSV" fallback if needed.

## Proposed Changes

### Data Integration & Logic
- **CSV Parsing**: Utilize the existing `SheetJS` library to parse `similar_callsign.csv`.
- **Data Mapping**:
    - Callsign Pair: `FP1_CALLSIGN` | `FP2_CALLSIGN`
    - Sector: Map `CCP` column to human-readable names or use as ID.
    - Similarity: Use `SIMILARITY` and `SCORE_PEAK` to determine urgency levels.
    - Status: Default to 'DETECTED' status.
- **Dynamic Updates**: Implement an `updateData()` function that refreshes the UI whenever new data is loaded or polled.

### UI & Aesthetics (Premium ATC Style)
- **Theme**: High-contrast Dark Mode with Glassmorphism.
    - Background: Deep navy gradient (`#0b1120` to `#0f172a`).
    - Cards: Semi-transparent panels with blur effect.
- **Typography**: Modern sans-serif (Inter/Outfit) for maximum readability in low-light environments.
- **Animations**: 
    - Subtle pulsing neon borders for "Very High" similarity alerts.
    - Smooth list transitions when data updates.
- **Component Refactoring**:
    - **Header**: Global status bar with system health and real-time clock.
    - **Sector Summaries**: Re-layout as "Radar Scopes" or "Progress rings" for a more tech-heavy look.
    - **Detection Table**: High-density rows with distinct visual grouping of callsign pairs.

## Verification Plan

### Automated Tests
- Since this is a pure HTML/JS project, I'll use the browser subagent to:
    1. Open `simiar_callsign.html`.
    2. Check if the table renders rows (verifying CSV loading).
    3. Click a row to verify the Error Reporting modal pops up with pre-filled data.

### Manual Verification
1. User to open the file in a browser.
2. Verify that the "Dark Mode" aesthetic is visually appealing and "stunning" as per requirements.
3. Confirm that clicking "Report" correctly adds the entry to the "Reported List" tab.
