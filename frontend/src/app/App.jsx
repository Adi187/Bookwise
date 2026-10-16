import { Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import SearchPage from '../pages/SearchPage.jsx';
import LibraryPage from '../pages/LibraryPage.jsx';
import PasswordResetPage from '../pages/PasswordResetPage.jsx';
import LoginPage from '../pages/LoginPage.jsx';
import BookDetailsPage from '../pages/BookDetailsPage.jsx';
import BookQAPage from '../pages/BookQAPage.jsx';
import AppShell from '../components/layout/AppShell.jsx';
import { useAuth } from '../auth/context.js';
function RequireAuth() { const { user } = useAuth(); return user ? <Outlet /> : <Navigate to="/login" replace />; }
export default function App() {
  return <Routes>
    <Route path="/login" element={<LoginPage key="login" />} /><Route path="/register" element={<LoginPage key="register" register />} />
    <Route path="/forgot-password" element={<PasswordResetPage key="forgot" />} />
    <Route path="/reset-password" element={<PasswordResetPage key="reset" reset />} />
    <Route element={<RequireAuth />}><Route element={<AppShell />}>
      <Route path="/" element={<Navigate to="/library" replace />} />
      <Route path="/library" element={<LibraryPage />} /><Route path="/search" element={<SearchPage />} />
      <Route path="/books/:identifier" element={<BookDetailsPage />} />
      <Route path="/library/:sourceId" element={<BookDetailsPage />} />
      <Route path="/library/:sourceId/ask" element={<BookQAPage />} />
      <Route path="*" element={<div className="page-stack"><h1>Page not found</h1><Link className="text-link" to="/library">Return to Library</Link></div>} />
    </Route></Route>
  </Routes>;
}
