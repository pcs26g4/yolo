import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import "../styles/MapView.css";
import { getTickets } from "../../services/api";
import L from "leaflet";

/* Fix for default marker icon in react-leaflet */
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png",
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
});

/* -------------------- CONSTANTS -------------------- */
const DEFAULT_CENTER = [16.29974, 80.45729]; // Guntur
const DEFAULT_ZOOM = 13;

/* -------------------- MAP RESET -------------------- */
function ResetMap({ reset }) {
  const map = useMap();

  useEffect(() => {
    if (reset) {
      map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    }
  }, [reset, map]);

  return null;
}

/* -------------------- COMPLAINT MARKER -------------------- */
function ComplaintMarker({ position, label }) {
  const map = useMap();

  useEffect(() => {
    if (position) {
      map.setView(position, 16);
    }
  }, [position, map]);

  if (!position) return null;

  return (
    <Marker position={position}>
      <Popup>
        <div className="popup-card">
          <div className="popup-title">
            {label || "Complaint Location"}
          </div>
          <div className="popup-row">
            Exact latitude & longitude
          </div>
        </div>
      </Popup>
    </Marker>
  );
}

/* -------------------- MAP VIEW -------------------- */
export default function MapView() {
  const location = useLocation();

  const [complaintPos, setComplaintPos] = useState(null);
  const [complaintLabel, setComplaintLabel] = useState("");
  const [allTickets, setAllTickets] = useState([]);
  const [loading, setLoading] = useState(true);

  const isRedirected = Boolean(location.state?.lat && location.state?.lng);

  /* Fetch all tickets for map markers */
  useEffect(() => {
    const fetchTickets = async () => {
      try {
        const response = await getTickets();
        const ticketsData = response.tickets || [];

        const ticketsWithLocations = [];
        ticketsData.forEach(ticket => {
          (ticket.sub_tickets || []).forEach(subTicket => {
            const lat = subTicket.latitude;
            const lng = subTicket.longitude;

            if (lat && lng) {
              ticketsWithLocations.push({
                ...subTicket,
                ticket_id: ticket.ticket_id,
                latitude: lat,
                longitude: lng,
                area: ticket.area,
                district: ticket.district
              });
            }
          });
        });

        setAllTickets(ticketsWithLocations);
      } catch (error) {
        console.error("Failed to fetch tickets for map:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchTickets();
  }, []);

  /* Handle navigation state */
  useEffect(() => {
    if (isRedirected) {
      setComplaintPos([location.state.lat, location.state.lng]);
      setComplaintLabel(location.state.label || "Complaint Location");
    } else {
      setComplaintPos(null);
      setComplaintLabel("");
    }
  }, [location.state, isRedirected]);

  return (
    <div className="map-section">
      <div className="map-header">
        <h3>Live Detection Map</h3>
      </div>

      <div className="map-shell">
        <MapContainer
          center={DEFAULT_CENTER}
          zoom={DEFAULT_ZOOM}
          className="map"
        >
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

          <ResetMap reset={!isRedirected} />

          {isRedirected && (
            <ComplaintMarker
              position={complaintPos}
              label={complaintLabel}
            />
          )}

          {!loading && allTickets.map((ticket) => {
            if (!ticket.latitude || !ticket.longitude) return null;

            return (
              <Marker
                key={ticket.sub_id || ticket.ticket_id}
                position={[ticket.latitude, ticket.longitude]}
                eventHandlers={{
                  click: (e) => {
                    const map = e.target._map;
                    map.setView(e.latlng, 16);
                  },
                }}
              >
                <Popup>
                  <div className="popup-card">
                    <div className="popup-title">
                      Ticket ID: <span className="ticket-id">{ticket.ticket_id}</span>
                    </div>

                    <div className="popup-row">
                      <strong>Sub ID:</strong> {ticket.sub_id || "-"}
                    </div>

                    <div className="popup-row">
                      <strong>Issue:</strong> {ticket.issue_type || "-"}
                    </div>

                    <div className="popup-row">
                      <strong>Authority:</strong> {ticket.authority || "-"}
                    </div>

                    <div className="popup-row">
                      <strong>Status:</strong> {ticket.status || "-"}
                    </div>

                    <div className="popup-row">
                      <strong>Area:</strong> {ticket.area || "-"}
                    </div>

                    <div className="popup-row">
                      <strong>District:</strong> {ticket.district || "-"}
                    </div>

                    <div className="popup-row">
                      <strong>Location:</strong>{" "}
                      {ticket.latitude.toFixed(6)}, {ticket.longitude.toFixed(6)}
                    </div>
                  </div>
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>
      </div>
    </div>
  );
}
