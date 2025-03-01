import React from 'react';

const LandingPage: React.FC = () => {
    const version = process.env.REACT_APP_BUILD_VERSION;

    return (
        <div style={{ padding: '1rem' }}>
            <h2>Landing Page</h2>
            <p>Welcome to Chess Launchpad. Please log in or explore.</p>
            
            {version && (
              <div style={{ marginTop: '1rem', fontStyle: 'italic' }}>
                Build version: {version}
              </div>
            )}
        </div>
    );
};

export default LandingPage;
