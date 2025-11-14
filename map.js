/*
 * map.js
 *
 * This module sets up the Mapbox map, loads external data via D3, and creates
 * an interactive scatterplot overlay showing Bluebikes traffic patterns in
 * Boston and Cambridge. Circle sizes represent traffic volume and colours
 * represent the ratio of departures to arrivals. A time slider filters the
 * data by time of day.
 */

// Import Mapbox GL JS and D3 as ES modules from their respective CDNs
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';

// Set your own Mapbox access token here. Replace the placeholder with your
// personal token from your Mapbox account. Do NOT commit your private token
// to any public repository.
// Set your Mapbox token. This has been replaced with the default public token
// from the authenticated Mapbox account. Keep this private in production!
mapboxgl.accessToken = 'pk.eyJ1Ijoidml2aWFuY2hlbmN3eSIsImEiOiJjbWh6N3IwMGcwYXU0Mmtwd250ano3NzVzIn0.eTGrXa7s_mwcEr6AJfX9_g';

// Initialize the Mapbox map once the page loads. We choose the Boston/Cambridge
// area as the centre and an appropriate zoom range. Feel free to adjust the
// style, centre, or zoom values for your own aesthetic.
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027], // longitude, latitude
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

// Helper functions defined outside of map.on('load') so that they can be
// reused anywhere in this file.

/**
 * Compute the number of minutes since midnight from a Date object.
 * @param {Date} date A date-time value
 * @returns {number} Minutes since 00:00
 */
function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Efficiently filter trips by minute using pre-bucketed lists. If minute === -1,
 * returns all trips. Otherwise returns trips that started within ±60 minutes of
 * the selected time. Uses modulus arithmetic to handle wrap-around at midnight.
 * @param {Array[]} tripsByMinute An array with 1440 arrays of trips
 * @param {number} minute The selected minute from the slider, or -1
 */
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    // Flatten all buckets when no filter is applied
    return tripsByMinute.flat();
  }
  // Normalize minute boundaries
  let minMinute = (minute - 60 + 1440) % 1440;
  let maxMinute = (minute + 60) % 1440;
  if (minMinute > maxMinute) {
    // The window straddles midnight; concatenate two slices
    let beforeMidnight = tripsByMinute.slice(minMinute);
    let afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  } else {
    return tripsByMinute.slice(minMinute, maxMinute).flat();
  }
}

/**
 * Compute per-station traffic statistics from arrivals and departures buckets.
 * Returns a new array of stations with departures, arrivals and totalTraffic
 * properties updated. If timeFilter is omitted, uses all trips.
 *
 * @param {Object[]} stations List of station objects
 * @param {number} timeFilter Minute from slider (-1 means no filtering)
 * @returns {Object[]} Updated station objects with traffic counts
 */
function computeStationTraffic(stations, timeFilter = -1) {
  // Look up pre-filtered trips. We rely on departuresByMinute and arrivalsByMinute
  const deps = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );
  const arrs = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );
  return stations.map((station) => {
    const id = station.short_name;
    station.departures = deps.get(id) ?? 0;
    station.arrivals = arrs.get(id) ?? 0;
    station.totalTraffic = station.departures + station.arrivals;
    return station;
  });
}

// Global variables for performance optimisations. They are populated in the
// map.on('load') handler once trip data is downloaded and parsed.
let departuresByMinute;
let arrivalsByMinute;
let circles; // D3 selection for circles
let stations; // Will hold station data with computed traffic
let radiusScale; // Scale for circle size
let stationFlow; // Scale for departure ratio

// Main asynchronous setup when map has loaded all resources. This is where
// external data is fetched, the base layers are added, and the D3 overlay is
// constructed.
map.on('load', async () => {
  // 1. Add external GeoJSON layers for bike lanes. Using separate sources
  // ensures each dataset can be styled independently. The colour and width
  // values here can be adjusted to your taste.
  const bostonLanesUrl =
    'https://opendata.arcgis.com/datasets/47783c53561b40f3a7221f7febc8ab3a_0.geojson';
  const cambridgeLanesUrl =
    'https://opendata.arcgis.com/datasets/0bf450426b724b6a89fae33efa709a14_0.geojson';

  map.addSource('boston-lanes', { type: 'geojson', data: bostonLanesUrl });
  map.addLayer({
    id: 'boston-lanes',
    type: 'line',
    source: 'boston-lanes',
    paint: {
      'line-color': '#00cc77',
      'line-width': 2,
      'line-opacity': 0.8,
    },
  });
  map.addSource('cambridge-lanes', { type: 'geojson', data: cambridgeLanesUrl });
  map.addLayer({
    id: 'cambridge-lanes',
    type: 'line',
    source: 'cambridge-lanes',
    paint: {
      'line-color': '#00cc77',
      'line-width': 2,
      'line-opacity': 0.8,
    },
  });

  // 2. Fetch station information. The Bluebikes GBFS feed provides station
  // metadata including name, short_name (ID), and geographic coordinates. We
  // keep it as-is for now; computeStationTraffic() will later add traffic.
  const stationResponse = await d3.json(
    'https://gbfs.bluebikes.com/gbfs/en/station_information.json',
  );
  stations = stationResponse.data.stations;

  // 3. Fetch trip traffic data for March 2024. While this file is large (~21MB)
  // loading it over the network is necessary for the visualization. We parse
  // date strings into Date objects immediately so that subsequent filtering is
  // fast. Modify the URL if a more recent dataset becomes available.
  let trips = await d3.csv(
    'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
    (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);
      return trip;
    },
  );

  // 4. Pre-bucket trips by minute for efficient time filtering. Each bucket is
  // an array representing one minute of the day. departuresByMinute and
  // arrivalsByMinute are global so computeStationTraffic() can access them.
  departuresByMinute = Array.from({ length: 1440 }, () => []);
  arrivalsByMinute = Array.from({ length: 1440 }, () => []);
  trips.forEach((trip) => {
    const depMinute = minutesSinceMidnight(trip.started_at);
    const arrMinute = minutesSinceMidnight(trip.ended_at);
    departuresByMinute[depMinute].push(trip);
    arrivalsByMinute[arrMinute].push(trip);
  });

  // 5. Compute initial traffic statistics. Passing -1 uses the full dataset.
  stations = computeStationTraffic(stations, -1);

  // 6. Add an SVG overlay on top of the Mapbox canvas to draw circles. We
  // position it absolutely so it covers the map area. D3 will manage circle
  // creation and updates.
  const container = map.getCanvasContainer();
  const svg = d3.select(container).append('svg');

  // 7. Define scales for circle size and colour. Radius uses a square-root
  // scale to map total traffic to area. The colour scale discretises the
  // departure ratio (0–1) into three values used in CSS variables.
  radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);
  stationFlow = d3
    .scaleQuantize()
    .domain([0, 1])
    .range([0, 0.5, 1]);

  // 8. Project station lat/lon to screen coordinates. This helper uses
  // map.project() to convert geographic coordinates to pixel positions.
  function projectPoint(station) {
    const projected = map.project([station.lon, station.lat]);
    return projected;
  }

  // 9. Initial draw of circles. Use the station short_name as the key for
  // efficient joins. Append a <title> element to each circle for a native
  // browser tooltip showing detailed counts.
  circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name)
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .attr('cx', (d) => projectPoint(d).x)
    .attr('cy', (d) => projectPoint(d).y)
    .style('--departure-ratio', (d) =>
      stationFlow(d.totalTraffic === 0 ? 0.5 : d.departures / d.totalTraffic),
    )
    .each(function (d) {
      d3.select(this)
        .append('title')
        .text(
          `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`,
        );
    });

  // 10. Keep circles in sync with map pan/zoom/resize. Called whenever the map
  // moves or zooms. D3 does not track the projection automatically, so we
  // recompute the x/y attributes each time.
  function updatePositions() {
    circles
      .attr('cx', (d) => projectPoint(d).x)
      .attr('cy', (d) => projectPoint(d).y);
  }
  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('moveend', updatePositions);
  map.on('resize', updatePositions);

  // 11. Handle slider interactions. The slider lives in index.html. When the
  // user adjusts it, we recompute traffic, rescale circle sizes and colours,
  // update the tooltip text, and reposition circles. We also update the
  // displayed time label.
  const timeSlider = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  /**
   * Format minutes since midnight into a locale-specific time string.
   * @param {number} minutes Number of minutes since midnight
   */
  function formatTime(minutes) {
    const date = new Date(0, 0, 0, 0, minutes);
    return date.toLocaleString('en-US', { timeStyle: 'short' });
  }

  /**
   * Redraw the scatterplot when the slider value changes. Adjusts the radius
   * scale range depending on whether a filter is applied. Uses D3’s join() to
   * update existing circles instead of destroying them. Updates the tooltip
   * contents accordingly.
   *
   * @param {number} timeFilter Minute from slider, or -1 when no filter
   */
  function updateScatterPlot(timeFilter) {
    // Recompute per-station traffic for the selected time
    const updated = computeStationTraffic(stations, timeFilter);
    // Adjust radius scale: larger circles when filtered
    if (timeFilter === -1) {
      radiusScale.range([0, 25]);
    } else {
      radiusScale.range([3, 50]);
    }
    // Bind new data, using short_name as a key. Use join() to update existing
    // circles. Note: we reuse the global 'circles' selection to keep listeners.
    circles = circles
      .data(updated, (d) => d.short_name)
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', (d) =>
        stationFlow(d.totalTraffic === 0 ? 0.5 : d.departures / d.totalTraffic),
      )
      .each(function (d) {
        // Update tooltip text
        const title = d3.select(this).select('title');
        if (!title.empty()) {
          title.text(
            `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`,
          );
        }
      });
    // Reposition circles after data update
    updatePositions();
  }

  /**
   * Update displayed time label and trigger recomputation when the slider moves.
   */
  function updateTimeDisplay() {
    const value = Number(timeSlider.value);
    if (value === -1) {
      selectedTime.textContent = '';
      anyTimeLabel.style.display = 'inline';
    } else {
      selectedTime.textContent = formatTime(value);
      anyTimeLabel.style.display = 'none';
    }
    updateScatterPlot(value);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  // Initialize everything based on the slider’s starting value
  updateTimeDisplay();
});