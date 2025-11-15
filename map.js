import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';

mapboxgl.accessToken = 'pk.eyJ1Ijoidml2aWFuY2hlbmN3eSIsImEiOiJjbWh6NnRqOG0wNmd5MmlweTQxaWQybjJoIn0.bgKO2pL-uOGAK-unettFXQ';

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027], 
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat();
  }
  let minMinute = (minute - 60 + 1440) % 1440;
  let maxMinute = (minute + 60) % 1440;
  if (minMinute > maxMinute) {
    let beforeMidnight = tripsByMinute.slice(minMinute);
    let afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  } else {
    return tripsByMinute.slice(minMinute, maxMinute).flat();
  }
}

function computeStationTraffic(stations, timeFilter = -1) {
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

let departuresByMinute;
let arrivalsByMinute;
let circles;
let stations;
let radiusScale;
let stationFlow;

map.on('load', async () => {
  const bostonLanesUrl =
    'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson?outSR=%7B%22latestWkid%22%3A3857%2C%22wkid%22%3A102100%7D';
  const cambridgeLanesUrl =
    'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson';

  try {
    console.log('Loading Boston bike lanes...');
    const bostonLanes = await d3.json(bostonLanesUrl);
    console.log('Boston lanes loaded:', bostonLanes?.features?.length || 0, 'features');
    
    if (bostonLanes && bostonLanes.features && bostonLanes.features.length > 0) {
      map.addSource('boston-lanes', { type: 'geojson', data: bostonLanes });
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
      console.log('Boston bike lanes layer added successfully');
    } else {
      console.warn('Boston lanes data is empty or invalid');
    }

    console.log('Loading Cambridge bike lanes...');
    const cambridgeLanes = await d3.json(cambridgeLanesUrl);
    console.log('Cambridge lanes loaded:', cambridgeLanes?.features?.length || 0, 'features');
    
    if (cambridgeLanes && cambridgeLanes.features && cambridgeLanes.features.length > 0) {
      map.addSource('cambridge-lanes', { type: 'geojson', data: cambridgeLanes });
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
      console.log('Cambridge bike lanes layer added successfully');
    } else {
      console.warn('Cambridge lanes data is empty or invalid');
    }
  } catch (error) {
    console.error('Error loading bike lanes:', error);
    console.error('Error details:', error.message);
  }

  const stationResponse = await d3.json(
    'https://gbfs.bluebikes.com/gbfs/en/station_information.json',
  );
  stations = stationResponse.data.stations;

  let trips = await d3.csv(
    'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
    (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);
      return trip;
    },
  );

  departuresByMinute = Array.from({ length: 1440 }, () => []);
  arrivalsByMinute = Array.from({ length: 1440 }, () => []);
  trips.forEach((trip) => {
    const depMinute = minutesSinceMidnight(trip.started_at);
    const arrMinute = minutesSinceMidnight(trip.ended_at);
    departuresByMinute[depMinute].push(trip);
    arrivalsByMinute[arrMinute].push(trip);
  });

  stations = computeStationTraffic(stations, -1);

  const container = map.getCanvasContainer();
  const svg = d3.select(container).append('svg');

  radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);
  stationFlow = d3
    .scaleQuantize()
    .domain([0, 1])
    .range([0, 0.5, 1]);

  function projectPoint(station) {
    const projected = map.project([station.lon, station.lat]);
    return projected;
  }

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

  function updatePositions() {
    circles
      .attr('cx', (d) => projectPoint(d).x)
      .attr('cy', (d) => projectPoint(d).y);
  }
  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('moveend', updatePositions);
  map.on('resize', updatePositions);

  const timeSlider = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  function formatTime(minutes) {
    const date = new Date(0, 0, 0, 0, minutes);
    return date.toLocaleString('en-US', { timeStyle: 'short' });
  }

  function updateScatterPlot(timeFilter) {
    const updated = computeStationTraffic(stations, timeFilter);
    if (timeFilter === -1) {
      radiusScale.range([0, 25]);
    } else {
      radiusScale.range([3, 50]);
    }

    circles = circles
      .data(updated, (d) => d.short_name)
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', (d) =>
        stationFlow(d.totalTraffic === 0 ? 0.5 : d.departures / d.totalTraffic),
      )
      .each(function (d) {
        const title = d3.select(this).select('title');
        if (!title.empty()) {
          title.text(
            `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`,
          );
        }
      });
    updatePositions();
  }

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
  updateTimeDisplay();
});
