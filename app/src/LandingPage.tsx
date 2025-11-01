import React from 'react';

const LandingPage: React.FC = () => {
    const version = process.env.REACT_APP_BUILD_VERSION;

    return (
        <div style={{ 
            padding: '1rem',
            minHeight: 'calc(100vh - 60px)', // Subtract header height
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between'
        }}>
            <div>
                <h2>TEST Memorize Chess Openings, Scientifically</h2>
                
                <p>Chess Launchpad offers a streamlined method to master chess openings through adaptive repetition and real-time feedback. Experience interactive play guided by weighted probabilities tailored to your specific memorization needs, instantly identifying and correcting mistakes. Clear progress indicators and motivational badges keep you engaged and focused.</p>
                
                <p>Turn chess openings from daunting to effortless. With Chess Launchpad's scientifically-backed approach, every move reinforces your memory, ensuring you never forget a critical move order again.</p>
            </div>
            
            {version && (
              <div style={{ 
                fontSize: '0.7rem', 
                color: '#666', 
                fontStyle: 'italic',
                textAlign: 'center',
                paddingBottom: '0.5rem'
              }}>
                Build version: {version}
              </div>
            )}
        </div>
    );
};

export default LandingPage;
