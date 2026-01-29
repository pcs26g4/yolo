import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/AdminPage.css";
import TicketLog from "./TicketLog";
import { getTickets, getImageUrl, getUsers, createInspector, deleteUser, getInspectorActions, resolveSubTicket } from "../../services/api";

export default function AdminPage() {
  const [users, setUsers] = useState([]);
  const [actions, setActions] = useState([]);
  const [complaints, setComplaints] = useState([]);
  const [view, setView] = useState("inspectors");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const user = JSON.parse(localStorage.getItem("user"));

  /* ================= NOTIFICATION TRACKING ================= */
  const [lastSeen, setLastSeen] = useState(() => {
    return JSON.parse(localStorage.getItem("admin_last_seen")) || {
      inspectors: 0,
      complaints: 0,
      actions: 0,
      accounts: 0
    };
  });

  const markSectionAsSeen = (section, items) => {
    if (!items || items.length === 0) return;

    // For complaints, we use numericId, for others we use id
    const maxId = Math.max(...items.map(item =>
      section === "complaints" ? (item.numericId || 0) : (item.id || 0)
    ));

    if (maxId > (lastSeen[section] || 0)) {
      const updated = { ...lastSeen, [section]: maxId };
      setLastSeen(updated);
      localStorage.setItem("admin_last_seen", JSON.stringify(updated));
    }
  };
  
  /* ================= STATE ================= */
  const [filterDepartment, setFilterDepartment] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all"); // 'all', 'user', 'inspector'

  const [showAddInspectorModal, setShowAddInspectorModal] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);

  const [createdInspector, setCreatedInspector] = useState(null);

  // Delete Popup State
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletedInspectorName, setDeletedInspectorName] = useState("");
  const [deleteModalType, setDeleteModalType] = useState(""); // "inspector" or "ticket"

  // Confirm Delete State
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [selectedInspector, setSelectedInspector] = useState(null);

  // Error Popup State
  const [showErrorPopup, setShowErrorPopup] = useState(false);
  const [errorPopupMessage, setErrorPopupMessage] = useState("");

  // Inspector Complaints View State
  const [showInspectorComplaintsModal, setShowInspectorComplaintsModal] = useState(false);
  const [viewingInspector, setViewingInspector] = useState(null);
  const [inspectorComplaints, setInspectorComplaints] = useState([]);

  const [newInspector, setNewInspector] = useState({
    name: "",
    email: "",
    password: "",
    department: "",
    confirmPassword: ""
  });
  const navigate = useNavigate();

  /* ================= SLA RULES ================= */
  const SLA_RULES = {
    pathholes: 12,
    garbage: 8,
    streetdebris: 10,
    street_debris: 10,
    animalcarcas: 12,
    animalcarcass: 12
  };

  // Department options matching the signup form
  const DEPARTMENT_OPTIONS = [
    { value: "Roads", label: "Roads Department" },
    { value: "Garbage", label: "Garbage Department" }
  ];

  /* ================= LOAD USERS & ACTIONS ================= */
  const loadData = async () => {
    try {
      // Load Users
      const usersData = await getUsers();
      if (usersData.users) {
        setUsers(usersData.users);
      }

      // Load Actions
      const actionsData = await getInspectorActions();
      if (actionsData.actions) {
        setActions(actionsData.actions);
      }
    } catch (err) {
      console.error("Error loading admin data:", err);
      setErrorPopupMessage("Failed to load admin data: " + err.message);
      setShowErrorPopup(true);
    }
  };

  useEffect(() => {
    loadData();
    // Poll for updates every 10 seconds
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, []);

  /* ================= LOAD COMPLAINTS ================= */
  const loadComplaints = async () => {
    try {
      const response = await getTickets();
      const extracted = [];

      (response.tickets || []).forEach(ticket => {
        (ticket.sub_tickets || []).forEach(st => {
          const issue = st.issue_type;
          const slaHours = SLA_RULES[issue] || 12;

          extracted.push({
            id: st.sub_id,
            numericId: st.id,
            issue_type: issue,
            confidence: st.confidence,
            image: st.image_id,
            date: st.created_at,
            status: st.status || "open",
            latitude: st.latitude,
            longitude: st.longitude,
            area: ticket.area,
            district: ticket.district,
            mediaType: st.media_type,
            slaHours,
            ticketId: ticket.ticket_id,
            user_name: ticket.user_name,
            assigned_to: st.assigned_to
          });
        });
      });

      // Sort by date (newest first)
      extracted.sort((a, b) => new Date(b.date) - new Date(a.date));

      setComplaints(extracted);
      localStorage.setItem("admin_complaints", JSON.stringify(extracted));
    } catch (err) {
      console.error("Error loading complaints:", err);
      setErrorPopupMessage("Failed to load complaints: " + err.message);
      setShowErrorPopup(true);
    }
  };

  useEffect(() => {
    loadComplaints();
    // Optional: Poll for updates every 10 seconds to keep admin view fresh too
    const interval = setInterval(loadComplaints, 10000);
    return () => clearInterval(interval);
  }, []);

  // auto-mark as seen if already in the view
  useEffect(() => {
    if (view === "inspectors") markSectionAsSeen("inspectors", inspectors);
    if (view === "complaints") markSectionAsSeen("complaints", complaints);
    if (view === "actions") markSectionAsSeen("actions", actions);
    if (view === "accounts") markSectionAsSeen("accounts", allAccounts);
  }, [view, users, complaints, actions]);

  /* ================= HELPERS ================= */
  const handleLogout = () => {
    localStorage.removeItem("user");
    localStorage.removeItem("admin_complaints");
    navigate("/");
  };

  const checkSLABreach = (date, slaHours) => {
    if (!date) return false;
    const created = new Date(date);
    const hoursPassed = (new Date() - created) / 36e5;
    return hoursPassed > slaHours;
  };

  /* ================= UPDATE STATUS (ADMIN) ================= */
  const updateComplaintStatus = async (id, newStatus) => {
    try {
      // Optimistic update for UI responsiveness
      const previousComplaints = [...complaints];
      setComplaints(complaints.map(c =>
        c.id === id ? { ...c, status: newStatus } : c
      ));

      // Call API to update status in backend
      // Passing null for proof file, and a comment
      await resolveSubTicket(id, newStatus, null, "Status updated by Admin", "Admin");

      // Refresh data to ensure synchronization
      await loadComplaints();
      await loadData();

    } catch (err) {
      console.error("Failed to update status:", err);
      setErrorPopupMessage("Failed to update complaint status: " + err.message);
      setShowErrorPopup(true);
      // Revert optimistic update on failure (re-fetch would also fix it)
      loadComplaints();
      loadData();
    }
  };

  /* ================= USER MANAGEMENT ================= */
  const refreshUsers = async () => {
    try {
      const data = await getUsers();
      if (data.users) setUsers(data.users);
    } catch (err) {
      console.error("Error refreshing users:", err);
      setErrorPopupMessage("Failed to refresh users: " + err.message);
      setShowErrorPopup(true);
    }
  };

  // Updated removeInspector function with confirmation modal
  const removeInspector = (id) => {
    const inspector = users.find(u => u.id === id);
    if (inspector) {
      setSelectedInspector(inspector);
      setShowConfirmDelete(true);
    }
  };

  const deleteAccount = async (id, name) => {
    if (window.confirm(`Delete account: ${name}?\nThis action cannot be undone.`)) {
      try {
        await deleteUser(id);
        setDeletedInspectorName(name);
        setDeleteModalType("inspector");
        setShowDeleteModal(true);
        refreshUsers();
      } catch (err) {
        setErrorPopupMessage("Failed to delete account: " + err.message);
        setShowErrorPopup(true);
      }
    }
  };

  /* ================= ADD INSPECTOR FUNCTION ================= */
  const handleAddInspector = async () => {
    // Validate inputs
    if (!newInspector.name.trim() || !newInspector.email.trim() ||
      !newInspector.password || !newInspector.department) {
      setErrorPopupMessage("Please fill in all fields");
      setShowErrorPopup(true);
      return;
    }

    if (newInspector.password !== newInspector.confirmPassword) {
      setErrorPopupMessage("Passwords do not match");
      setShowErrorPopup(true);
      return;
    }

    if (newInspector.password.length < 6) {
      setErrorPopupMessage("Password must be at least 6 characters long");
      setShowErrorPopup(true);
      return;
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newInspector.email)) {
      setErrorPopupMessage("Please enter a valid email address");
      setShowErrorPopup(true);
      return;
    }

    try {
      await createInspector(
        newInspector.name.trim(),
        newInspector.email.trim(),
        newInspector.password,
        newInspector.department
      );

      // Refresh users list
      await refreshUsers();

      // Reset form and close modal
      setNewInspector({
        name: "",
        email: "",
        password: "",
        department: "",
        confirmPassword: ""
      });
      setShowAddInspectorModal(false);

      setCreatedInspector({
        name: newInspector.name,
        email: newInspector.email,
        password: newInspector.password,
        department: newInspector.department
      });
      setShowSuccessModal(true);

    } catch (err) {
      setErrorPopupMessage(err.message || "Email already registered");
      setShowErrorPopup(true);
    }
  };

  const viewInspectorComplaints = (inspector) => {
    setViewingInspector(inspector);
    // Find complaints assigned to this inspector ID
    const assigned = complaints.filter(c => c.assigned_to === inspector.id);
    setInspectorComplaints(assigned);
    setShowInspectorComplaintsModal(true);
  };

  /* ================= FILTERS & SEARCH ================= */
  const inspectors = users.filter(u => u.role === "INSPECTOR");
  const normalUsers = users.filter(u => u.role === "USER");

  // All accounts for the accounts tab
  const allAccounts = [...normalUsers, ...inspectors];

  // Get department label from value
  const getDepartmentLabel = (value) => {
    const dept = DEPARTMENT_OPTIONS.find(opt => opt.value === value);
    return dept ? dept.label : value || "Not assigned";
  };

  // Filter accounts based on search, department, and account type
  const filteredAccounts = allAccounts.filter(account => {
    const matchesSearch = searchQuery === "" ||
      account.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      account.email.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesDepartment = filterDepartment === "all" ||
      account.department === filterDepartment ||
      (!account.department && filterDepartment === "none");

    const matchesType = accountFilter === "all" ||
      (accountFilter === "user" && account.role === "USER") ||
      (accountFilter === "inspector" && account.role === "INSPECTOR");

    return matchesSearch && matchesDepartment && matchesType;
  });

  // Filter inspectors by department
  const filteredInspectors = filterDepartment === "all"
    ? inspectors
    : inspectors.filter(i => i.department === filterDepartment);

  // Get unique departments from existing users
  const departments = [...new Set(allAccounts
    .map(a => a.department)
    .filter(Boolean)
    .filter(dept => DEPARTMENT_OPTIONS.some(opt => opt.value === dept))
  )];

  return (
    <div className="admin-layout">
      {/* ================= SIDEBAR ================= */}
      <aside className={`admin-sidebar ${sidebarOpen ? "open" : ""}`}>
        <h2 className="sidebar-title">Admin Panel</h2>

        <button
          className={`sidebar-btn ${view === "inspectors" ? "active" : ""}`}
          onClick={() => {
            setView("inspectors");
            setSidebarOpen(false);
            markSectionAsSeen("inspectors", inspectors);
          }}
        >
          <span className="btn-icon"></span>
          Inspectors
          {inspectors.filter(i => i.id > (lastSeen.inspectors || 0)).length > 0 && (
            <span className="badge-count">
              {inspectors.filter(i => i.id > (lastSeen.inspectors || 0)).length}
            </span>
          )}
        </button>

        <button
          className={`sidebar-btn ${view === "complaints" ? "active" : ""}`}
          onClick={() => {
            setView("complaints");
            setSidebarOpen(false);
            markSectionAsSeen("complaints", complaints);
          }}
        >
          <span className="btn-icon"></span>
          Complaints
          {complaints.filter(c => c.numericId > (lastSeen.complaints || 0)).length > 0 && (
            <span className="badge-count">
              {complaints.filter(c => c.numericId > (lastSeen.complaints || 0)).length}
            </span>
          )}
        </button>

        <button
          className={`sidebar-btn ${view === "tickets" ? "active" : ""}`}
          onClick={() => { setView("tickets"); setSidebarOpen(false); }}
        >
          <span className="btn-icon"></span>
          Ticket Logs
        </button>

        <button
          className={`sidebar-btn ${view === "actions" ? "active" : ""}`}
          onClick={() => {
            setView("actions");
            setSidebarOpen(false);
            markSectionAsSeen("actions", actions);
          }}
        >
          <span className="btn-icon"></span>
          Inspector Actions
          {actions.filter(a => a.id > (lastSeen.actions || 0)).length > 0 && (
            <span className="badge-count">
              {actions.filter(a => a.id > (lastSeen.actions || 0)).length}
            </span>
          )}
        </button>

        {/* ACCOUNTS TAB */}
        <button
          className={`sidebar-btn ${view === "accounts" ? "active" : ""}`}
          onClick={() => {
            setView("accounts");
            setSidebarOpen(false);
            markSectionAsSeen("accounts", allAccounts);
          }}
        >
          <span className="btn-icon"></span>
          All Accounts
          {allAccounts.filter(a => a.id > (lastSeen.accounts || 0)).length > 0 && (
            <span className="badge-count">
              {allAccounts.filter(a => a.id > (lastSeen.accounts || 0)).length}
            </span>
          )}
        </button>

        {/* STATS SUMMARY */}
        <div className="sidebar-stats">
          <h4>Quick Stats</h4>
          <div className="stat-item">
            <span className="stat-label">Users:</span>
            <span className="stat-value">{normalUsers.length}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Inspectors:</span>
            <span className="stat-value approved">{inspectors.length}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Total Accounts:</span>
            <span className="stat-value">{allAccounts.length}</span>
          </div>
        </div>
      </aside>

      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}

      {/* ================= ADD INSPECTOR MODAL ================= */}
      {showAddInspectorModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Add New Inspector</h3>
              {/* Close Button at Top Right */}
              <button
                className="modal-close-btn"
                onClick={() => setShowAddInspectorModal(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label>Full Name *</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Enter inspector's full name"
                  value={newInspector.name}
                  onChange={(e) => setNewInspector({ ...newInspector, name: e.target.value })}
                  required
                  autoComplete="off"
                />
              </div>

              <div className="form-group">
                <label>Email Address *</label>
                <input
                  type="email"
                  className="form-input"
                  placeholder="Enter email address"
                  value={newInspector.email}
                  onChange={(e) => setNewInspector({ ...newInspector, email: e.target.value })}
                  required
                  autoComplete="off"
                />
              </div>

              <div className="form-group">
                <label>Password * (min 6 characters)</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="Set password"
                  value={newInspector.password}
                  onChange={(e) => setNewInspector({ ...newInspector, password: e.target.value })}
                  required
                  minLength="6"
                  autoComplete="new-password"
                />
              </div>

              <div className="form-group">
                <label>Confirm Password *</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="Confirm password"
                  value={newInspector.confirmPassword}
                  onChange={(e) => setNewInspector({ ...newInspector, confirmPassword: e.target.value })}
                  required
                  autoComplete="new-password"
                />
              </div>

              <div className="form-group">
                <label>Department *</label>
                <select
                  className="form-select"
                  value={newInspector.department}
                  onChange={(e) => setNewInspector({ ...newInspector, department: e.target.value })}
                  required
                >
                  <option value="" disabled>Select Department</option>
                  {DEPARTMENT_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="modal-footer">
              <button
                className="btn-secondary"
                onClick={() => setShowAddInspectorModal(false)}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={handleAddInspector}
              >
                Create Inspector
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= ERROR POPUP ================= */}
      {showErrorPopup && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: "420px" }}>
            <div className="modal-header">
              <h3 style={{ color: "#dc2626" }}>Action Failed</h3>
              <button
                className="modal-close-btn"
                onClick={() => setShowErrorPopup(false)}
              >
                ×
              </button>
            </div>

            <div
              className="modal-body"
              style={{ textAlign: "center", padding: "20px" }}
            >
              <p style={{ fontSize: "16px", color: "#334155" }}>
                {errorPopupMessage}
              </p>
            </div>

            <div className="modal-footer" style={{ justifyContent: "center" }}>
              <button
                className="btn-primary"
                onClick={() => setShowErrorPopup(false)}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= CONFIRM DELETE MODAL ================= */}
      {showConfirmDelete && selectedInspector && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: "420px" }}>
            <div className="modal-header">
              <h3>Confirm Removal</h3>
              <button
                className="modal-close-btn"
                onClick={() => setShowConfirmDelete(false)}
              >
                ×
              </button>
            </div>

            <div className="modal-body" style={{ textAlign: "center" }}>
              <p style={{ fontSize: "16px", marginBottom: "10px" }}>
                Are you sure you want to remove this inspector?
              </p>

              <strong style={{ color: "#dc2626", fontSize: "18px" }}>
                {selectedInspector.name}
              </strong>

              <p style={{ marginTop: "10px", color: "#64748b" }}>
                This will revoke their access permanently.
              </p>
            </div>

            <div className="modal-footer">
              <button
                className="btn-secondary"
                onClick={() => setShowConfirmDelete(false)}
              >
                Cancel
              </button>

              <button
                className="btn-primary"
                style={{ background: "#dc2626" }}
                onClick={async () => {
                  try {
                    await deleteUser(selectedInspector.id);
                    setDeletedInspectorName(selectedInspector.name);
                    setDeleteModalType("inspector");
                    setShowConfirmDelete(false);
                    setShowDeleteModal(true);
                    refreshUsers();
                  } catch (err) {
                    setErrorPopupMessage("Failed to remove inspector: " + err.message);
                    setShowErrorPopup(true);
                  }
                }}
              >
                Remove Inspector
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= SUCCESS MODAL ================= */}
      {showSuccessModal && createdInspector && (
        <div className="modal-overlay">
          <div className="modal-content success-modal-content" style={{ maxWidth: '450px', padding: '0', overflow: 'hidden' }}>
            <div className="success-modal-header">
              <span className="success-icon-large">✅</span>
              <h2 className="success-title">Inspector Added!</h2>
              <p className="success-subtitle">Account created successfully</p>
            </div>

            <div className="modal-body" style={{ padding: '30px' }}>
              <p className="success-help-text" style={{ textAlign: 'center', marginBottom: '20px', color: '#64748b' }}>
                Please share these login credentials with the inspector.
              </p>

              <div className="credentials-box">
                <div className="credential-item">
                  <label className="credential-label">EMAIL</label>
                  <div className="credential-value">{createdInspector.email}</div>
                </div>
                <div className="credential-item">
                  <label className="credential-label">PASSWORD</label>
                  <div className="credential-value">{createdInspector.password}</div>
                </div>
                <div className="credential-item">
                  <label className="credential-label">DEPARTMENT</label>
                  <div className="credential-value">{getDepartmentLabel(createdInspector.department)}</div>
                </div>
              </div>
            </div>

            <div className="modal-footer" style={{ borderTop: 'none', paddingBottom: '30px', justifyContent: 'center' }}>
              <button
                className="btn-success-full"
                onClick={() => setShowSuccessModal(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= DELETE SUCCESS MODAL ================= */}
      {showDeleteModal && (
        <div className="modal-overlay">
          <div className="modal-content success-modal-content" style={{ maxWidth: '400px', padding: '0', overflow: 'hidden' }}>
            {deleteModalType === "inspector" ? (
              // Inspector Delete Modal (Red)
              <>
                <div className="success-modal-header" style={{ background: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)' }}>
                  <span className="success-icon-large">❌</span>
                  <h2 className="success-title">Inspector Removed</h2>
                  <p className="success-subtitle">Access revoked successfully</p>
                </div>

                <div className="modal-body" style={{ padding: '30px', textAlign: 'center' }}>
                  <p style={{ fontSize: '16px', color: '#64748b', marginBottom: '10px' }}>
                    You have successfully removed inspector:
                  </p>
                  <div style={{
                    fontSize: '20px',
                    fontWeight: '700',
                    color: '#1e293b',
                    background: '#f1f5f9',
                    padding: '10px',
                    borderRadius: '8px',
                    display: 'inline-block'
                  }}>
                    {deletedInspectorName}
                  </div>
                </div>

                <div className="modal-footer" style={{ borderTop: 'none', paddingBottom: '30px', justifyContent: 'center' }}>
                  <button
                    className="btn-success-full"
                    onClick={() => setShowDeleteModal(false)}
                    style={{ background: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)', boxShadow: '0 4px 12px rgba(239, 68, 68, 0.3)' }}
                  >
                    Close
                  </button>
                </div>
              </>
            ) : (
              // Ticket Delete Modal (Blue)
              <>
                <div className="success-modal-header" style={{ background: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)' }}>
                  <span className="success-icon-large">❌</span>
                  <h2 className="success-title">Ticket Deleted</h2>
                  <p className="success-subtitle">Deleted successfully</p>
                </div>

                <div className="modal-footer" style={{ borderTop: 'none', padding: '30px', justifyContent: 'center' }}>
                  <button
                    className="btn-success-full"
                    onClick={() => setShowDeleteModal(false)}
                    style={{ background: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)', boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)' }}
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ================= MAIN ================= */}
      <div className="admin-main">
        <header className="admin-topbar">
          <button className="menu-btn" onClick={() => setSidebarOpen(true)}>☰</button>
          <h2>Admin Dashboard</h2>
          <div className="topbar-actions">
            <span className="welcome-text">Welcome, {user?.name || "Admin"}</span>
            <button className="logout-btn" onClick={handleLogout}>Logout</button>
          </div>
        </header>

        <div className="admin-container">
          {/* ================= INSPECTORS ================= */}
          {view === "inspectors" && (
            <>
              <div className="view-header">
                <h2>Inspector Management</h2>
                <div className="header-controls">
                  <div className="filter-controls">
                    <select
                      className="filter-select"
                      value={filterDepartment}
                      onChange={(e) => setFilterDepartment(e.target.value)}
                    >
                      <option value="all">All Departments</option>
                      {departments.map(dept => (
                        <option key={dept} value={dept}>
                          {getDepartmentLabel(dept)}
                        </option>
                      ))}
                      <option value="none">No Department</option>
                    </select>
                  </div>

                  {/* Add Inspector Button */}
                  <button
                    className="add-inspector-btn"
                    onClick={() => setShowAddInspectorModal(true)}
                  >
                    <span className="btn-icon">➕</span>
                    Add Inspector
                  </button>
                </div>
              </div>

              {/* Inspectors List */}
              <div className="admin-card">
                <div className="card-header">
                  <h3>All Inspectors ({filteredInspectors.length})</h3>
                  <span className="subtitle">Active inspectors with system access</span>
                  
                </div>

                {filteredInspectors.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-icon"></div>
                    <p>No inspectors found</p>
                    {filterDepartment !== "all" && (
                      <button
                        className="clear-filter-btn"
                        onClick={() => setFilterDepartment("all")}
                      >
                        Clear Filter
                      </button>
                    )}
                    <button
                      className="add-inspector-btn-empty"
                      onClick={() => setShowAddInspectorModal(true)}
                    >
                      ➕ Add Your First Inspector
                    </button>
                  </div>
                ) : (
                  <div className="inspectors-grid">
                    {filteredInspectors.map(i => (
                      <div className="inspector-card" key={i.id}>
                        <div className="inspector-header">
                          <div className="inspector-avatar">
                            {i.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="inspector-info">
                            <h4>{i.name}</h4>
                            <p className="inspector-email">{i.email}</p>
                          </div>
                        </div>

                        <div className="inspector-details">
                          <div className="detail-item">
                            <span className="detail-label">Department:</span>
                            <span className="detail-value department-badge">
                              {getDepartmentLabel(i.department)}
                            </span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">Role:</span>
                            <span className="detail-value">Inspector</span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">Status:</span>
                            <span className="detail-value active">Active</span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">Created:</span>
                            <span className="detail-value">
                              {i.createdAt ? new Date(i.createdAt).toLocaleDateString() : 'N/A'}
                            </span>
                          </div>
                        </div>

                        <div className="inspector-actions">
                          <button
                            className="action-btn view-btn"
                            onClick={() => viewInspectorComplaints(i)}
                          >
                            <span className="btn-icon"></span>
                            View Complaints
                          </button>
                          <button
                            className="action-btn remove-btn"
                            onClick={() => removeInspector(i.id)}
                          >
                            <span className="btn-icon">❌</span>
                            Remove Inspector
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ================= ACCOUNTS TAB ================= */}
          {view === "accounts" && (
            <>
              <div className="view-header">
                <h2>Account Management</h2>
                <div className="header-controls">
                  <div className="search-box">
                    <input
                      type="text"
                      placeholder="Search by name or email..."
                      className="search-input"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                    <span className="search-icon">🔍</span>
                  </div>
                  <div className="filter-controls">
                    <select
                      className="filter-select"
                      value={filterDepartment}
                      onChange={(e) => setFilterDepartment(e.target.value)}
                    >
                      <option value="all">All Departments</option>
                      {departments.map(dept => (
                        <option key={dept} value={dept}>
                          {getDepartmentLabel(dept)}
                        </option>
                      ))}
                      <option value="none">No Department</option>
                    </select>
                  </div>
                  <button
                    className="add-inspector-btn"
                    onClick={() => setShowAddInspectorModal(true)}
                  >
                    <span className="btn-icon">➕</span>
                    Add Inspector
                  </button>
                </div>
              </div>

              <div className="accounts-container">
                {/* Summary Cards */}
                <div className="summary-cards">
                  <div
                    className={`summary-card total-users ${accountFilter === 'all' ? 'active-filter' : ''}`}
                    onClick={() => setAccountFilter('all')}
                    style={{ cursor: 'pointer', border: accountFilter === 'all' ? '2px solid #3b82f6' : '' }}
                  >
                    <div className="summary-icon">👥</div>
                    <div className="summary-content">
                      <h4>Total Accounts</h4>
                      <p className="summary-count">{allAccounts.length}</p>
                    </div>
                  </div>
                  <div
                    className={`summary-card normal-users ${accountFilter === 'user' ? 'active-filter' : ''}`}
                    onClick={() => setAccountFilter('user')}
                    style={{ cursor: 'pointer', border: accountFilter === 'user' ? '2px solid #8b5cf6' : '' }}
                  >
                    <div className="summary-icon">👤</div>
                    <div className="summary-content">
                      <h4>Regular Users</h4>
                      <p className="summary-count">
                        {normalUsers.length}
                      </p>
                    </div>
                  </div>
                  <div
                    className={`summary-card approved-inspectors ${accountFilter === 'inspector' ? 'active-filter' : ''}`}
                    onClick={() => setAccountFilter('inspector')}
                    style={{ cursor: 'pointer', border: accountFilter === 'inspector' ? '2px solid #10b981' : '' }}
                  >
                    <div className="summary-icon"></div>
                    <div className="summary-content">
                      <h4>Inspectors</h4>
                      <p className="summary-count">
                        {inspectors.length}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Accounts Table */}
                <div className="admin-card">
                  <div className="card-header">
                    <h3>All Accounts ({filteredAccounts.length})</h3>
                    <span className="subtitle">
                      Showing {filteredAccounts.length} of {allAccounts.length} accounts
                      {searchQuery && ` matching "${searchQuery}"`}
                    </span>
                  </div>

                  {filteredAccounts.length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-icon">📭</div>
                      <p>No accounts found</p>
                      {(searchQuery || filterDepartment !== "all") && (
                        <button
                          className="clear-filter-btn"
                          onClick={() => {
                            setSearchQuery("");
                            setFilterDepartment("all");
                          }}
                        >
                          Clear Filters
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="accounts-table-container">
                      <div className="accounts-table">
                        <div className="table-header">
                          <span>Name</span>
                          <span>Email</span>
                          <span>Department</span>
                          <span>Role</span>
                          <span>Status</span>
                          <span>Actions</span>
                        </div>

                        {filteredAccounts.map(user => (
                          <div className="table-row" key={user.id}>
                            <span className="user-name">
                              <div className="user-avatar-small">
                                {user.name.charAt(0).toUpperCase()}
                              </div>
                              {user.name}
                            </span>
                            <span className="email-cell">{user.email}</span>
                            <span>
                              {user.department ? (
                                <span className="department-tag">
                                  {getDepartmentLabel(user.department)}
                                </span>
                              ) : (
                                <span className="no-dept">—</span>
                              )}
                            </span>
                            <span>
                              {user.role === "INSPECTOR" ? (
                                <span className="badge badge-inspector">Inspector</span>
                              ) : (
                                <span className="badge badge-user">User</span>
                              )}
                            </span>
                            <span>
                              <span className="badge badge-active">Active</span>
                            </span>
                            <span className="action-buttons">
                              <button
                                className="icon-btn delete-btn"
                                onClick={() => deleteAccount(user.id, user.name)}
                                title="Delete Account"
                              >
                                ❌
                              </button>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ================= COMPLAINTS (ADMIN) ================= */}
          {view === "complaints" && (
            <>
              <div className="view-header">
                <h2>Complaints Management</h2>
                <span className="subtitle">Manage and monitor all complaints</span>
              </div>

              {complaints.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon"></div>
                  <p>No complaints found</p>
                </div>
              ) : (
                <div className="complaints-grid">
                  {complaints.map(c => {
                    const breached = checkSLABreach(c.date, c.slaHours);

                    return (
                      <div
                        key={c.id}
                        className="complaint-card-grid"
                        style={{
                          border: breached ? "2px solid #ef4444" : "1px solid #444"
                        }}
                      >
                        <div className="complaint-image-wrapper">
                          {c.image ? (
                            <img
                              src={getImageUrl(c.image)}
                              className="complaint-image-grid"
                              alt="Complaint"
                            />
                          ) : (
                            <div className="no-media-box">No Media</div>
                          )}
                        </div>

                        <div className="complaint-info-grid">
                          <p className="raised-by-top"><strong>User:</strong> <span className="user-tag">{c.user_name || "Anonymous"}</span></p>
                          <p><strong>Sub ID:</strong> {c.id}</p>
                          <p><strong>Issue:</strong> {c.issue_type}</p>
                          <p><strong>Confidence:</strong> {(c.confidence * 100).toFixed(1)}%</p>

                          {/* 🔥 STATUS DROPDOWN (ADMIN) */}
                          <div className="status-control">
                            <strong>Status:</strong>
                            <select
                              className="status-dropdown"
                              value={c.status}
                              onChange={(e) =>
                                updateComplaintStatus(c.id, e.target.value)
                              }
                            >
                              <option value="open">Open</option>
                              <option value="assigned">Assigned</option>
                              <option value="in_progress">In Progress</option>
                              <option value="resolved">Resolved</option>
                              <option value="closed">Closed</option>
                            </select>
                          </div>

                          <p><strong>TAT (SLA):</strong> {c.slaHours} hrs</p>

                          <p>
                            <strong>SLA Breach:</strong>{" "}
                            {breached ? (
                              <span className="breach-indicator">
                                YES ⚠️
                              </span>
                            ) : (
                              <span className="no-breach">
                                NO ✔
                              </span>
                            )}
                          </p>

                          <p><strong>Area:</strong> {c.area}</p>
                          <p><strong>District:</strong> {c.district}</p>
                          <p><strong>Date:</strong> {new Date(c.date).toLocaleString()}</p>

                          {c.latitude && c.longitude && (
                            <p>
                              <strong>Location:</strong>{" "}
                              <a
                                href={`https://maps.google.com/?q=${c.latitude},${c.longitude}`}
                                target="_blank"
                                rel="noreferrer"
                                className="map-link"
                              >
                                {c.latitude.toFixed(6)}, {c.longitude.toFixed(6)}
                              </a>
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* ================= TICKETS ================= */}
          {view === "tickets" && (
            <div className="ticket-log-container">
              <div className="view-header">
                <h2>Ticket Logs</h2>
                <span className="subtitle">Complete audit trail of all system activities</span>
              </div>
              <div className="ticket-log-card">
                <TicketLog onDeleteSuccess={() => {
                  setDeleteModalType("ticket");
                  setShowDeleteModal(true);
                }} />
              </div>
            </div>
          )}

          {/* ================= ACTIONS ================= */}
          {view === "actions" && (
            <div className="actions-container">
              <div className="view-header">
                <h2>Inspector Actions Log</h2>
                <span className="subtitle">Track all inspector activities</span>
              </div>

              <div className="admin-card">
                <div className="card-header">
                  <h3>Recent Actions ({actions.length})</h3>
                </div>

                {actions.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-icon"></div>
                    <p>No actions recorded yet</p>
                  </div>
                ) : (
                  <div className="actions-list">
                    {actions.map(a => (
                      <div className="action-item" key={a.id}>
                        <div className="action-header">
                          <div className="action-avatar">
                            {a.inspectorName?.charAt(0).toUpperCase() || 'I'}
                          </div>
                          <div className="action-info">
                            <h4>{a.inspectorName || 'Unknown Inspector'}</h4>
                            <p className="action-time">{a.time}</p>
                          </div>
                          <span className="action-type">{a.action}</span>
                        </div>

                        <div className="action-details">
                          <p className="action-description">
                            <strong>Action:</strong> {a.action}
                          </p>
                          <p className="action-ticket">
                            <strong>Ticket ID:</strong> {a.ticketId}
                          </p>
                          {a.details && (
                            <p className="action-extra">
                              <strong>Details:</strong> {a.details}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        {/* ================= INSPECTOR COMPLAINTS MODAL ================= */}
        {showInspectorComplaintsModal && viewingInspector && (
          <div className="modal-overlay">
            <div className="modal-content complaints-modal">
              <div className="modal-header">
                <div className="view-header-accent">
                  <span className="accent-icon"></span>
                  <div>
                    <h3>Complaints for {viewingInspector.name}</h3>
                    <p className="subtitle">{viewingInspector.department} Department • {inspectorComplaints.length} active tasks</p>
                  </div>
                </div>
                <button
                  className="modal-close-btn"
                  onClick={() => setShowInspectorComplaintsModal(false)}
                >
                  ×
                </button>
              </div>

              <div className="modal-body inspector-complaints-list">
                {inspectorComplaints.length === 0 ? (
                  <div className="empty-state-small">
                    <div className="empty-icon">📂</div>
                    <p>No complaints currently assigned to this inspector.</p>
                  </div>
                ) : (
                  <div className="inspector-complaints-grid">
                    {inspectorComplaints.map(c => (
                      <div className={`mini-complaint-card status-${c.status}`} key={c.id}>
                        <div className="mini-card-main">
                          <div className="mini-card-img">
                            {c.image ? (
                              <img src={getImageUrl(c.image)} alt="Preview" />
                            ) : (
                              <div className="no-img-placeholder">No Image</div>
                            )}
                          </div>
                          <div className="mini-card-info">
                            <div className="mini-card-header">
                              <span className="mini-id">#{c.id}</span>
                              <span className={`mini-status ${c.status}`}>{c.status}</span>
                            </div>
                            <h4 className="mini-issue">{c.issue_type}</h4>
                            <p className="mini-location"> {c.area}, {c.district}</p>
                            <p className="mini-date"> {new Date(c.date).toLocaleDateString()}</p>
                          </div>
                        </div>
                        <div className="mini-card-footer">
                          <button
                            className="mini-view-btn"
                            onClick={() => {
                              setShowInspectorComplaintsModal(false);
                              setView("complaints");
                              setSearchQuery(c.id);
                            }}
                          >
                            View Full Details →
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="modal-footer">
                <button
                  className="btn-secondary"
                  onClick={() => setShowInspectorComplaintsModal(false)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}