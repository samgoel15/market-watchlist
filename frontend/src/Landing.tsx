import Spline from "@splinetool/react-spline";

type LandingProps = {
  onEnter: () => void;
};

export default function Landing({ onEnter }: LandingProps) {
  return (
    <main
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "#0a0a0a",
      }}
    >
      <Spline
        scene="https://prod.spline.design/XLRF3ScGmpqhtcD8/scene.splinecode"
        style={{ width: "100%", height: "100%" }}
      />
      <button
        type="button"
        onClick={onEnter}
        style={{
          position: "absolute",
          bottom: "32px",
          left: "50%",
          transform: "translateX(-50%)",
          padding: "12px 24px",
          border: "0",
          borderRadius: "8px",
          color: "#0a0a0a",
          background: "#4dff8a",
          fontSize: "15px",
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Enter App
      </button>
      <button
        type="button"
        onClick={onEnter}
        style={{
          position: "absolute",
          top: "24px",
          right: "24px",
          padding: "4px",
          border: "0",
          color: "#ffffff",
          background: "transparent",
          fontSize: "13px",
          textDecoration: "underline",
          cursor: "pointer",
        }}
      >
        Skip
      </button>
    </main>
  );
}
