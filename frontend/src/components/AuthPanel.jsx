export default function AuthPanel({
  email,
  setEmail,
  password,
  setPassword,
  loading,
  onLogin,
  onRegister,
}) {
  return (
    <>
      <label>
        Usuario (email)
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="tu_correo@dominio.com"
          disabled={loading}
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
        />
      </label>
      <div className="auth-buttons">
        <button onClick={onLogin} disabled={loading}>
          Iniciar sesion
        </button>
        <button onClick={onRegister} disabled={loading} className="btn-secondary">
          Crear cuenta
        </button>
      </div>
    </>
  );
}
